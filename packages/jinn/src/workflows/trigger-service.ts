import { Buffer } from "node:buffer";
import cron, { type ScheduledTask } from "node-cron";
import { validateCronSchedule } from "../cron/validation.js";
import { logger } from "../shared/logger.js";
import { claimWorkItem, releaseWorkItemClaim } from "../work-items/claims.js";
import { normalizeLabelName } from "../work-items/labels.js";
import { appendRespawnGuardHold, checkRespawnGuard } from "../work-items/respawn-guards.js";
import { createWorkflowTodoEventFeed, type WorkflowTodoEventClaimOutcome,
  type WorkflowTodoEventFeed, type WorkflowTodoStatusEvent } from "../work-items/workflow-event-feed.js";
import { jsonValueSchema, type JsonValue, type TriggerNode, type WorkflowDefinition } from "./model.js";
import { WorkflowRepositoryError, type WorkflowRepository } from "./repository.js";
import type { WorkflowRunDetail } from "./runtime.js";
import type { WorkflowRunner } from "./runner.js";

export interface FireWorkflowEventInput {
  eventName: string;
  fireId: string;
  payload: Record<string, JsonValue>;
}

interface IndexedTrigger { definition: WorkflowDefinition; trigger: TriggerNode }
interface TodoCandidate extends IndexedTrigger { mismatch: TodoMismatch | undefined }
interface ScheduleIndex extends IndexedTrigger { task: ScheduledTask }
function bad(message: string): never { throw new WorkflowRepositoryError("bad-input", message); }
function payload(value: unknown): Record<string, JsonValue> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    bad("Workflow event payload must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 64 * 1024) bad("Workflow event payload must be at most 64 KiB.");
  return parsed.data as Record<string, JsonValue>;
}
function trigger(definition: WorkflowDefinition, kind: TriggerNode["config"]["kind"]): TriggerNode | undefined {
  return definition.nodes.find((node): node is TriggerNode => node.type === "trigger" && node.config.kind === kind);
}
function labelMatches(filter: string, labels: WorkflowTodoStatusEvent["item"]["labels"]): boolean {
  let name: string; try { name = normalizeLabelName(filter); } catch { return false; }
  return labels.some((label) => label.id === filter || label.name === name);
}
/** Which filter refused a Todo event, and why. The `filter` half exists because
 *  `label` is the one refusal that can be a race rather than a decision. */
interface TodoMismatch { filter: "label" | "other"; reason: string }
function refused(reason: string): TodoMismatch { return { filter: "other", reason }; }
/** Why this Todo event does NOT match the trigger, or undefined when it does.
 *  Filters are ANDed; the first mismatch is what gets reported, so a suppressed
 *  run always says which filter refused it. */
function todoMismatch(node: TriggerNode, event: WorkflowTodoStatusEvent): TodoMismatch | undefined {
  if (node.config.kind !== "todo-status") return refused("trigger is not a todo-status trigger");
  const { actor, label, department, assignee, delegates, unlabeled, unassigned, rootOnly } = node.config;
  // An arming delegate moved the Todo as itself, so the event names its session
  // rather than the operator; the stamp the status route wrote at that moment is
  // what says the operator's authority stands behind it. Only an `operator`
  // filter is widened, and only where the binding has not opted out.
  const armed = actor === "operator" && delegates !== false && event.armedAsDelegate !== null;
  if (actor !== undefined && actor !== event.actor && !armed) return refused(`actor ${event.actor ?? "unknown"} is not ${actor}`);
  if (department !== undefined && department !== event.item.department) return refused(`department filter ${department} does not match`);
  if (assignee !== undefined && assignee !== event.item.assignee) return refused(`assignee filter ${assignee} does not match`);
  const live = event.item.live;
  if (unlabeled !== undefined || unassigned !== undefined || rootOnly !== undefined) {
    // These three assert what the Todo IS right now, so a row that has since been
    // deleted answers none of them — an unknown Todo must refuse rather than fall
    // through as a match and arm a workflow on nothing.
    if (live === null) return refused("the Todo no longer exists, so its live filters cannot match");
    if (unlabeled && event.item.labels.length > 0) return refused("unlabeled filter does not match: the Todo carries labels");
    if (unassigned && live.assignee !== null) return refused(`unassigned filter does not match: the Todo is assigned to ${live.assignee}`);
    if (rootOnly && live.parentId !== null) return refused(`rootOnly filter does not match: the Todo is a child of ${live.parentId}`);
  }
  // Judged LAST on purpose: a `label` mismatch has to mean that every other filter
  // was satisfied, or a Todo refused for something a label cannot change would be
  // read as a race and left waiting for a label that would not have helped.
  if (label !== undefined && !labelMatches(label, event.item.labels)) {
    return { filter: "label", reason: `label filter ${label} does not match` };
  }
  return undefined;
}
/** Whether the Todo is still sitting where this event put it. Once it has moved
 *  on the event is stale, whatever a later write does to the Todo. */
function stillWhereTheEventLeftIt(event: WorkflowTodoStatusEvent): boolean {
  return event.item.live?.status === event.toStatus;
}
export class WorkflowTriggerService {
  private readonly schedules = new Map<string, ScheduleIndex>();
  private readonly todos = new Map<string, IndexedTrigger[]>();
  private readonly feed: WorkflowTodoEventFeed;

  constructor(private readonly repository: WorkflowRepository, private readonly runner: WorkflowRunner,
    private readonly now: () => string = () => new Date().toISOString(), feed?: WorkflowTodoEventFeed) {
    this.feed = feed ?? createWorkflowTodoEventFeed();
    this.rebuild();
  }
  dispose(): void { for (const item of this.schedules.values()) item.task.stop(); this.schedules.clear(); this.todos.clear(); }

  rebuild(): void {
    this.dispose();
    for (const definition of this.enabledDefinitions()) {
      const schedule = trigger(definition, "schedule");
      if (schedule && schedule.config.kind === "schedule") this.addSchedule(definition, schedule);
      const todo = trigger(definition, "todo-status");
      if (todo && todo.config.kind === "todo-status") {
        const items = this.todos.get(todo.config.status) ?? []; items.push({ definition, trigger: todo });
        this.todos.set(todo.config.status, items);
      }
    }
  }

  async fire(input: FireWorkflowEventInput): Promise<WorkflowRunDetail[]> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(input.eventName)
      || typeof input.fireId !== "string" || input.fireId.length < 1 || input.fireId.length > 128) bad("Workflow event identity is invalid.");
    const eventPayload = payload(input.payload); const runs: WorkflowRunDetail[] = [];
    for (const definition of this.enabledDefinitions()) {
      const event = definition.nodes.find((node): node is TriggerNode => node.type === "trigger"
        && node.config.kind === "event" && node.config.eventName === input.eventName);
      if (event) runs.push(await this.start(definition, event, input.fireId, eventPayload, `event:${input.fireId}`));
    }
    return runs;
  }

  async recoverTodoEvents(): Promise<number> {
    if (this.todos.size === 0) return 0;
    let count = 0;
    for (const event of this.feed.listPendingEvents(500)) count += await this.fireTodo(event);
    return count;
  }

  private enabledDefinitions(): WorkflowDefinition[] {
    const definitions: WorkflowDefinition[] = []; let cursor: string | undefined;
    do {
      const page = this.repository.listDefinitions({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      definitions.push(...page.items.map((item) => this.repository.getDefinition(item.id)!).filter(Boolean));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return definitions;
  }

  private addSchedule(definition: WorkflowDefinition, schedule: TriggerNode): void {
    if (schedule.config.kind !== "schedule") return;
    // A row stored before the authoring gate existed can still be unarmable;
    // skip-and-log it exactly as the Cron scheduler does, rather than throwing
    // out of rebuild() and taking the whole gateway down at boot.
    const errors = validateCronSchedule({ schedule: schedule.config.cron, timezone: schedule.config.timezone });
    if (errors.length > 0) {
      logger.warn(`Skipping invalid Workflow schedule "${definition.id}": ${errors.map((error) => error.message).join("; ")}`);
      return;
    }
    const revision = definition.revision;
    const task = cron.schedule(schedule.config.cron, () => { void this.fireSchedule(definition.id, revision); },
      { timezone: schedule.config.timezone });
    this.schedules.set(definition.id, { definition, trigger: schedule, task });
  }

  private async fireSchedule(workflowId: string, revision: number): Promise<void> {
    const indexed = this.schedules.get(workflowId);
    if (!indexed || indexed.definition.revision !== revision) return;
    const fireId = this.now();
    await this.start(indexed.definition, indexed.trigger, fireId, { scheduledAt: fireId }, `schedule:${fireId}`);
  }

  private async fireTodo(event: WorkflowTodoStatusEvent): Promise<number> {
    const candidates = (this.todos.get(event.toStatus) ?? [])
      .map((item) => ({ ...item, mismatch: todoMismatch(item.trigger, event) }));
    const indexed = candidates.filter((item) => item.mismatch === undefined);
    const claim = this.feed.claimEvent(event.id, indexed.map((item) => item.definition.id));
    if (claim.state !== "acquired") return 0;
    const allowed = new Set(claim.definitionIds);
    const outcomes = this.suppressionOutcomes(event, candidates);
    const labels = event.item.labels.map((label) => label.name);
    const runnable = indexed.filter((candidate) => allowed.has(candidate.definition.id));
    // A deferral is only good while the Todo sits where the event put it. Once it
    // has moved on the event is stale, and a label landing later must not fire a
    // run on work that has already gone somewhere else.
    if (claim.deferred && !stillWhereTheEventLeftIt(event)) {
      return this.suppressAll(event, runnable, outcomes, `${event.workItemId} has moved on from ${event.toStatus}`);
    }
    // Claim the TODO, not just the event: the event claim stops this event being
    // replayed, and this stops a DIFFERENT event — or another gateway — starting
    // a second run on work somebody is already doing. A rejected claim means the
    // Todo row is gone, and a Todo that no longer exists cannot be double-worked.
    const owner = `workflow:${event.id}`;
    // The respawn guards run BEFORE the claim (ICI-731): this is the automated
    // re-dispatch lane — status-driven pickup, and workflow re-arm one hop later
    // through the status transition it writes — and a Todo a guard refuses must
    // stay free for a human to dispatch by hand. One event, one audited hold,
    // however many definitions were about to run on it.
    const guard = runnable.length > 0 ? checkRespawnGuard(event.workItemId) : undefined;
    if (guard?.state === "held") {
      appendRespawnGuardHold(event.workItemId, guard, owner);
      return this.suppressAll(event, runnable, outcomes, `the ${guard.guard} guard holds it: ${guard.reason}`);
    }
    const todo = runnable.length > 0 ? claimWorkItem({ workItemId: event.workItemId, owner }) : undefined;
    if (todo?.state === "held") {
      return this.suppressAll(event, runnable, outcomes, `${event.workItemId} is already being worked by ${todo.claim.owner}`);
    }
    try {
      for (const item of runnable) {
        const run = await this.start(item.definition, item.trigger, event.id, {
          todoId: event.workItemId, fromStatus: event.fromStatus, toStatus: event.toStatus,
          actor: event.actor, source: event.item.source, department: event.item.department,
          assignee: event.item.assignee, labels, labelList: labels.join(", "),
        }, `todo:${event.id}`, event.workItemId);
        outcomes.push({ workflowId: item.definition.id, outcome: "started", runId: run.id, detail: `Todo event ${event.id} started.` });
      }
      this.settle(event, candidates, outcomes);
      return outcomes.filter((outcome) => outcome.outcome === "started").length;
    } catch (error) { releaseWorkItemClaim(event.workItemId, owner); this.feed.releaseEvent(event.id); throw error; }
  }

  /** Record WHY a candidate did not run: a filtered-out Todo event otherwise
   *  completes silently, which is indistinguishable from a broken trigger. */
  private suppressionOutcomes(event: WorkflowTodoStatusEvent,
    candidates: ReadonlyArray<TodoCandidate>): WorkflowTodoEventClaimOutcome[] {
    return candidates.filter((item) => item.mismatch !== undefined).map((item) => {
      const detail = `Todo event ${event.id} suppressed: ${item.mismatch!.reason}.`;
      logger.info(`Workflow ${item.definition.id}: ${detail}`);
      return { workflowId: item.definition.id, outcome: "suppressed" as const, detail };
    });
  }

  /**
   * Close the event, or put it back for the next drain.
   *
   * Labels are read when the event DRAINS, and the drain is kicked by the status
   * write, so a Todo labelled a moment after it moved is judged unlabelled — a
   * race, not a decision, and sealing the event there is what leaves the Todo
   * sitting at its arming status with nothing armed and nothing that will ever
   * look again. `todoMismatch` judges `label` last, so a label refusal means every
   * other filter on that definition was satisfied and the label alone is missing.
   *
   * Only the definitions the label refused go back in. The event is shared by
   * every definition bound to the status, and the ones that just started must not
   * be considered again when the label lands, or they run twice.
   */
  private settle(event: WorkflowTodoStatusEvent, candidates: ReadonlyArray<TodoCandidate>,
    outcomes: WorkflowTodoEventClaimOutcome[]): void {
    const waiting = candidates.filter((item) => item.mismatch?.filter === "label");
    if (waiting.length === 0 || !stillWhereTheEventLeftIt(event)) {
      this.feed.completeEvent(event.id, outcomes);
      return;
    }
    this.feed.deferEvent(event.id, waiting.map((item) => item.definition.id), outcomes);
  }

  /** Refuse every candidate that survived the filters for the same reason, and
   *  close the event on it. Two things stop a fire this late: a respawn guard,
   *  and the Todo already being worked by somebody else. */
  private suppressAll(event: WorkflowTodoStatusEvent, runnable: ReadonlyArray<IndexedTrigger>,
    outcomes: WorkflowTodoEventClaimOutcome[], reason: string): number {
    for (const item of runnable) {
      const detail = `Todo event ${event.id} suppressed: ${reason}.`;
      logger.info(`Workflow ${item.definition.id}: ${detail}`);
      outcomes.push({ workflowId: item.definition.id, outcome: "suppressed", detail });
    }
    this.feed.completeEvent(event.id, outcomes);
    return 0;
  }

  private async start(definition: WorkflowDefinition, source: TriggerNode, fireId: string,
    triggerPayload: Record<string, JsonValue>, idempotencyKey: string, todoId?: string): Promise<WorkflowRunDetail> {
    const created = this.repository.createRun({ workflowId: definition.id, input: {},
      trigger: { nodeId: source.id, kind: source.config.kind, fireId, payload: triggerPayload, ...(todoId ? { todoId } : {}) },
      idempotencyKey });
    const detail = this.repository.getRun(definition.id, created.id)!;
    return detail.status === "pending" ? this.runner.start(created.id) : detail;
  }
}
