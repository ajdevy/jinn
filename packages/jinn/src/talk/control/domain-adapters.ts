import type { ApiContext } from "../../gateway/api.js";
import { orgRegistry } from "../../gateway/org-registry.js";
import {
  getMessages,
  getSession,
} from "../../sessions/registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { addComment, commentsTail } from "../../work-items/comments.js";
import { getWorkItemLabels } from "../../work-items/labels.js";
import {
  getWorkItem,
  updateWorkItemConditional,
  type UpdateWorkItemInput,
} from "../../work-items/store.js";
import type { JsonValue } from "../../workflows/model.js";
import { TalkControlRuntime } from "./runtime.js";
import { initDb } from "../../shared/db.js";
import { TalkTopicLifecycle } from "../topics/lifecycle.js";
import { TalkTopicRepository } from "../topics/repository.js";
import type {
  TalkControlReceiptStore,
  TalkControlAdapterContext,
  TalkControlExecution,
  TalkControlManifest,
  TalkControlOperation,
} from "./types.js";
import { verifyTalkDomainOperation } from "./verification.js";
import { executeVoiceApproval } from "./voice-approval-adapter.js";
import { dispatchTalkSessionMessage } from "./session-message-adapter.js";
import { delegateTodoWithTalk } from "./delegation-adapter.js";
import { TALK_COMPANY_CAPABILITY_COVERAGE } from "./manifest.js";

export interface TalkControlHost {
  context: ApiContext;
  sourceSessionId: string;
  receipts?: TalkControlReceiptStore;
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function todoData(id: string): Record<string, unknown> {
  const item = getWorkItem(id);
  if (!item) throw new Error(`Todo ${id} not found`);
  const comments = commentsTail(id);
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    status: item.status,
    assignee: item.assignee,
    department: item.department,
    priority: item.priority,
    version: item.version,
    labels: getWorkItemLabels(id).map((label) => label.name),
    comments: comments.comments.map((comment) => ({ id: comment.id, author: comment.author, body: comment.body })),
    commentCount: comments.total,
  };
}

function sessionData(id: string): Record<string, unknown> {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  return {
    id: session.id,
    employee: session.employee,
    engine: session.engine,
    status: session.status,
    title: session.title,
    messages: getMessages(id).slice(-8).map((message) => ({ id: message.id, role: message.role, content: message.content })),
  };
}

function workflowInput(raw: unknown): Record<string, JsonValue> {
  if (raw === undefined || raw === "") return {};
  if (typeof raw !== "string") throw new Error("input must be a JSON object string");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("input must be a JSON object string");
  return parsed as Record<string, JsonValue>;
}

function delegateTodo(host: TalkControlHost, args: Record<string, unknown>, call: TalkControlAdapterContext): TalkControlExecution {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "employee");
  const item = getWorkItem(id);
  if (!item) throw new Error(`Todo ${id} not found`);
  const employee = orgRegistry(host.context.getConfig()).get(employeeName);
  if (!employee) throw new Error(`Employee ${employeeName} not found`);
  const prompt = typeof args.task === "string" && args.task.trim()
    ? args.task.trim()
    : [item.title, item.body].filter(Boolean).join("\n\n");
  return delegateTodoWithTalk({
    context: host.context,
    sourceSessionId: host.sourceSessionId,
    todoId: id,
    prompt,
    employee: {
      name: employee.name,
      department: employee.department ?? null,
      engine: employee.engine,
      model: employee.model,
      effortLevel: employee.effortLevel,
    },
    call,
  });
}

type DomainHandler = (
  host: TalkControlHost,
  args: Record<string, unknown>,
  call: TalkControlAdapterContext,
) => TalkControlExecution | Promise<TalkControlExecution>;

const readTodo: DomainHandler = (_host, args) => {
  const id = requiredText(args, "id");
  return { data: todoData(id), uiEffect: null };
};

function todoEditPatch(args: Record<string, unknown>): UpdateWorkItemInput {
  const patch: UpdateWorkItemInput = {};
  if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.body === "string") patch.body = args.body;
  if (Number.isInteger(args.priority) && Number(args.priority) >= 0 && Number(args.priority) <= 3) patch.priority = Number(args.priority);
  if (Object.keys(patch).length === 0) throw new Error("an editable field is required");
  return patch;
}

const editTodo: DomainHandler = (_host, args, call) => {
  const id = requiredText(args, "id");
  const expectedVersion = args.expectedVersion;
  if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) throw new Error("expectedVersion must be positive");
  const patch = todoEditPatch(args);
  const result = updateWorkItemConditional(id, patch, { expectedVersion: Number(expectedVersion), idempotencyKey: call.idempotencyKey, actor: "operator", origin: "talk" });
  if (!result) throw new Error(`Todo ${id} not found`);
  return { data: { todo: todoData(id), replayed: result.replayed }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const commentTodo: DomainHandler = (_host, args, call) => {
  const id = requiredText(args, "id");
  const comment = addComment({
    workItemId: id,
    body: requiredText(args, "body"),
    author: "operator",
    authorKind: "operator",
    origin: "talk",
    idempotencyKey: call.idempotencyKey,
  });
  return { data: { commentId: comment.id, todoId: id }, uiEffect: { invalidate: ["todos", `todo:${id}`, `todo-comments:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const assignTodo: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "assignee");
  const employee = orgRegistry(host.context.getConfig()).get(employeeName);
  if (!employee) throw new Error(`Employee ${employeeName} not found`);
  const item = assignWorkItem(id, employee.name, employee.department ?? null, "operator", "talk");
  if (!item) throw new Error(`Todo ${id} not found`);
  return { data: { todo: todoData(id) }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const sendToSession: DomainHandler = (host, args, call) => {
  const id = requiredText(args, "id");
  const sent = dispatchTalkSessionMessage(host.context, id, requiredText(args, "message"), call);
  return { data: { sessionId: id, ...sent }, uiEffect: { invalidate: ["sessions", `session:${id}`], navigate: `/?session=${encodeURIComponent(id)}` } };
};

const startWorkflow: DomainHandler = async (host, args, call) => {
  const id = requiredText(args, "id");
  if (!host.context.workflowService) throw new Error("Workflows are unavailable");
  const run = await host.context.workflowService.startManual({ workflowId: id, input: workflowInput(args.input), idempotencyKey: call.idempotencyKey });
  return { data: { workflowId: id, runId: run.id, status: run.status }, uiEffect: { invalidate: [`workflow-runs:${id}`, `workflow-run:${id}:${run.id}`], navigate: `/workflow/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}` } };
};

const readWorkflowRuns: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  if (!host.context.workflowService) throw new Error("Workflows are unavailable");
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(Number(args.limit), 1), 20) : 5;
  const page = host.context.workflowService.listRuns(id, { limit });
  return { data: { workflowId: id, runs: page.items }, uiEffect: null };
};

const readWorkflowRun: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  const runId = requiredText(args, "runId");
  const run = host.context.workflowService?.getRun(id, runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  return { data: { workflowId: id, run }, uiEffect: null };
};

const recallTopic: DomainHandler = (_host, args, call) => {
  const result = new TalkTopicLifecycle(new TalkTopicRepository(initDb())).resolve(
    call.talkSessionId,
    requiredText(args, "reference"),
  );
  if (result.status === "none") return { data: result, uiEffect: null };
  if (result.status === "ambiguous") {
    return { data: { ...result, candidates: result.candidates.map(({ id, label, kind }) => ({ id, label, kind })) }, uiEffect: null };
  }
  const route = result.topic.retrievalAnchors.find((anchor) => anchor.startsWith("route:"))?.slice(6);
  return {
    data: { status: result.status, reason: result.reason, confidence: result.confidence, topic: result.topic },
    uiEffect: route ? { navigate: route } : null,
  };
};

const rememberTopic: DomainHandler = (_host, args, call) => {
  const fields = ["goal", "decision", "unresolvedQuestion", "resolvedQuestion"] as const;
  if (!fields.some((field) => typeof args[field] === "string" && args[field].trim())) {
    throw new Error("A goal, decision, unresolved question, or resolved question is required");
  }
  const topic = new TalkTopicLifecycle(new TalkTopicRepository(initDb())).remember(call.talkSessionId, {
    ...(typeof args.topicId === "string" ? { topicId: args.topicId } : {}),
    ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
    ...(typeof args.decision === "string" ? { decision: args.decision } : {}),
    ...(typeof args.unresolvedQuestion === "string" ? { unresolvedQuestion: args.unresolvedQuestion } : {}),
    ...(typeof args.resolvedQuestion === "string" ? { resolvedQuestion: args.resolvedQuestion } : {}),
  });
  return { data: { topic }, uiEffect: null };
};

const readCapability: DomainHandler = (_host, args) => {
  const capability = requiredText(args, "capability");
  const coverage = TALK_COMPANY_CAPABILITY_COVERAGE[capability as keyof typeof TALK_COMPANY_CAPABILITY_COVERAGE];
  if (!coverage) {
    return {
      data: { status: "unknown", capability, knownCapabilities: Object.keys(TALK_COMPANY_CAPABILITY_COVERAGE) },
      uiEffect: null,
    };
  }
  return { data: { capability, ...coverage }, uiEffect: null };
};

const DOMAIN_HANDLERS: Record<string, DomainHandler> = {
  read_todo: readTodo,
  talk_edit_todo: editTodo,
  talk_comment_todo: commentTodo,
  talk_assign_todo: assignTodo,
  prepare_voice_approval: (_host, args, call) => executeVoiceApproval("prepare", args, call),
  commit_voice_approval: (_host, args, call) => executeVoiceApproval("commit", args, call),
  talk_delegate_todo: delegateTodo,
  read_session: (_host, args) => ({ data: sessionData(requiredText(args, "id")), uiEffect: null }),
  talk_send_to_session: sendToSession,
  talk_start_workflow_run: startWorkflow,
  read_workflow_runs: readWorkflowRuns,
  read_workflow_run: readWorkflowRun,
  talk_recall_topic: recallTopic,
  talk_remember_topic: rememberTopic,
  read_talk_capability: readCapability,
};

/** Every operation name this module can execute. Exported so the manifest can
 *  be proven complete rather than assumed to be. */
export const DOMAIN_HANDLER_NAMES: readonly string[] = Object.keys(DOMAIN_HANDLERS);

async function execute(host: TalkControlHost, operation: TalkControlOperation, args: Record<string, unknown>, call: TalkControlAdapterContext): Promise<TalkControlExecution> {
  const handler = DOMAIN_HANDLERS[operation.name];
  if (!handler) throw new Error(`No domain adapter for ${operation.name}`);
  return handler(host, args, call);
}

export function createTalkDomainRuntime(manifest: TalkControlManifest, host: TalkControlHost): TalkControlRuntime {
  return new TalkControlRuntime({
    manifest,
    execute: (operation, args, call) => execute(host, operation, args, call),
    verify: (operation, args, execution) => verifyTalkDomainOperation(operation, args, execution, host.context),
    ...(host.receipts ? { receipts: host.receipts } : {}),
  });
}
