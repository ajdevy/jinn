import { createHash } from "node:crypto";
import type { ApiContext } from "../../gateway/api.js";
import { scanOrg } from "../../gateway/org.js";
import { dispatchWebSessionRun } from "../../gateway/web-session-dispatch.js";
import {
  createSession,
  enqueueQueueItem,
  getMessages,
  getSession,
  getSessionBySessionKey,
  insertMessage,
  updateSession,
} from "../../sessions/registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { addComment, commentsTail } from "../../work-items/comments.js";
import { getWorkItemLabels } from "../../work-items/labels.js";
import { reconcileWorkItem } from "../../work-items/reconcile.js";
import {
  getWorkItem,
  linkSession,
  updateWorkItemConditional,
  type UpdateWorkItemInput,
} from "../../work-items/store.js";
import type { JsonValue } from "../../workflows/model.js";
import { TalkControlRuntime } from "./runtime.js";
import type {
  TalkControlAdapterContext,
  TalkControlExecution,
  TalkControlManifest,
  TalkControlOperation,
} from "./types.js";
import { verifyTalkDomainOperation } from "./verification.js";
import { executeVoiceApproval } from "./voice-approval-adapter.js";

export interface TalkControlHost {
  context: ApiContext;
  sourceSessionId: string;
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

function dispatchSession(host: TalkControlHost, sessionId: string, prompt: string): { messageId: string; queueItemId: string } {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const engine = host.context.sessionManager.getEngine(session.engine);
  if (!engine) throw new Error(`Engine ${session.engine} is unavailable`);
  const messageId = insertMessage(session.id, "user", prompt);
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
  host.context.emit("queue:updated", { sessionId: session.id, sessionKey });
  dispatchWebSessionRun(session, prompt, engine, host.context, { queueItemId });
  return { messageId, queueItemId };
}

function delegateTodo(host: TalkControlHost, args: Record<string, unknown>, call: TalkControlAdapterContext): TalkControlExecution {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "employee");
  const item = getWorkItem(id);
  if (!item) throw new Error(`Todo ${id} not found`);
  const employee = scanOrg(host.context.getConfig()).get(employeeName);
  if (!employee) throw new Error(`Employee ${employeeName} not found`);
  const engine = host.context.sessionManager.getEngine(employee.engine);
  if (!engine) throw new Error(`Engine ${employee.engine} is unavailable`);
  const digest = createHash("sha256").update(call.idempotencyKey).digest("hex");
  const sessionKey = `talk-delegation:${digest}`;
  const replay = getSessionBySessionKey(sessionKey);
  if (replay) {
    return { data: { todoId: id, sessionId: replay.id, employee: replay.employee, replayed: true }, uiEffect: { invalidate: [`todo:${id}`, `todo-sessions:${id}`, "sessions"], navigate: `/?session=${encodeURIComponent(replay.id)}` } };
  }
  const prompt = typeof args.task === "string" && args.task.trim()
    ? args.task.trim()
    : [item.title, item.body].filter(Boolean).join("\n\n");
  const assigned = assignWorkItem(id, employee.name, employee.department ?? null, "operator", "talk");
  if (!assigned) throw new Error(`Todo ${id} not found`);
  const session = createSession({
    engine: employee.engine,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee: employee.name,
    model: employee.model,
    effortLevel: employee.effortLevel,
    parentSessionId: host.sourceSessionId,
    prompt,
    title: `Delegate ${id}`,
  });
  insertMessage(session.id, "user", prompt);
  linkSession(id, session.id);
  reconcileWorkItem(id);
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  const queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
  host.context.emit("queue:updated", { sessionId: session.id, sessionKey });
  dispatchWebSessionRun(session, prompt, engine, host.context, { queueItemId });
  return { data: { todoId: id, sessionId: session.id, employee: employee.name, replayed: false }, uiEffect: { invalidate: [`todo:${id}`, `todo-sessions:${id}`, "sessions"], navigate: `/?session=${encodeURIComponent(session.id)}` } };
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

const commentTodo: DomainHandler = (_host, args) => {
  const id = requiredText(args, "id");
  const comment = addComment({ workItemId: id, body: requiredText(args, "body"), author: "operator", authorKind: "operator", origin: "talk" });
  return { data: { commentId: comment.id, todoId: id }, uiEffect: { invalidate: ["todos", `todo:${id}`, `todo-comments:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const assignTodo: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "assignee");
  const employee = scanOrg(host.context.getConfig()).get(employeeName);
  if (!employee) throw new Error(`Employee ${employeeName} not found`);
  const item = assignWorkItem(id, employee.name, employee.department ?? null, "operator", "talk");
  if (!item) throw new Error(`Todo ${id} not found`);
  return { data: { todo: todoData(id) }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const sendToSession: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  const sent = dispatchSession(host, id, requiredText(args, "message"));
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
};

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
  });
}
