import { logger } from "../shared/logger.js";
import {
  AVAILABILITY_RESUME_ACTOR,
  startAvailabilityResumeSweep,
  type AvailabilityRearmResult,
} from "../work-items/availability-resume.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { getWorkItemLabels, normalizeLabelName, setWorkItemLabels } from "../work-items/labels.js";
import type { WorkItemStatus } from "../work-items/store.js";
import { transition, TransitionError } from "../work-items/transitions.js";
import { resolveRearmTarget } from "../workflows/rearm-target.js";
import type { WorkflowRepository } from "../workflows/repository.js";

/**
 * The gateway half of the availability resume sweep (PLA-153): the sweep decides
 * WHEN a Todo comes back, this decides WHERE it lands.
 *
 * It lives here because answering that means reading a Workflow definition, and
 * `work-items/` does not import `workflows/`. Everything it does — the revision
 * lane on `transition`, the trigger lookup — is machinery that already existed
 * for a rejected gate sending work round again.
 */
export function startAvailabilityResumes(repository: WorkflowRepository): () => void {
  return startAvailabilityResumeSweep({ rearm: (todoId) => availabilityRearm(todoId, repository) });
}

/** One re-arm. Exported for tests; the sweep above is the only caller in anger. */
export function availabilityRearm(todoId: string, repository: WorkflowRepository): AvailabilityRearmResult {
  const workflowId = boundWorkflowId(todoId);
  if (workflowId === undefined) {
    return { unavailable: "no Workflow run has ever driven this Todo, so nothing says where a re-arm would land" };
  }
  const target = resolveRearmTarget(repository.getDefinition(workflowId), workflowId);
  if ("unavailable" in target) return target;

  if (target.label !== undefined) restoreArmingLabel(todoId, target.label);
  try {
    transition(todoId, target.status as WorkItemStatus, armingActor(target.actor), {
      requeue: true,
      detail: { workflowId, availabilityResume: true },
    });
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    return { unavailable: `it could not be moved to \`${target.status}\`: ${error.message}` };
  }
  return { status: target.status, ...(target.label === undefined ? {} : { label: target.label }) };
}

/**
 * The actor the re-armed status event carries.
 *
 * A trigger's `actor` filter is an authority boundary — it is what keeps an
 * arbitrary employee from starting a pipeline nobody asked for. This does not
 * cross it: the sweep only ever reaches a Todo whose own audit trail shows this
 * workflow ALREADY running on it, which is the arming that authority produced.
 * Resuming an attempt the operator armed is not the same act as arming one, and
 * the `availability_resumed` event beside it says which of the two happened.
 */
function armingActor(required: string | undefined): string {
  return required ?? AVAILABILITY_RESUME_ACTOR;
}

/** Which Workflow was driving this Todo, read off the status moves its own runs
 *  reflected onto it. Newest wins: a Todo re-armed into a different pipeline
 *  since then belongs to that one. */
function boundWorkflowId(todoId: string): string | undefined {
  const bound = listWorkItemEvents(todoId)
    .filter((event) => event.kind === "status_change" && typeof event.detail?.workflowId === "string");
  return bound.at(-1)?.detail?.workflowId as string | undefined;
}

/**
 * Put the trigger's label back if it has gone missing, because a status move
 * that misses the label filter fires nothing and the Todo would stop again one
 * silent step further on. Restoring it at re-arm time is deliberately all this
 * does — why labels go missing at all is its own question.
 */
function restoreArmingLabel(todoId: string, label: string): void {
  const present = getWorkItemLabels(todoId);
  let name: string;
  try {
    name = normalizeLabelName(label);
  } catch {
    return;
  }
  if (present.some((existing) => existing.id === label || existing.name === name)) return;
  try {
    setWorkItemLabels(todoId, [...present.map((existing) => existing.id), label], AVAILABILITY_RESUME_ACTOR);
  } catch (error) {
    // An unknown label ref is the workflow author's to fix; the re-arm still
    // happens, and the trigger's own suppression note will name the filter.
    logger.warn(`Todo ${todoId} could not have its arming label \`${label}\` restored: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}
