import { getMessages, getSession, listSessionsByWorkItem } from "../../sessions/registry.js";
import type { WorkflowService } from "../../workflows/service.js";
import { listComments } from "../../work-items/comments.js";
import { getWorkItem } from "../../work-items/store.js";
import type { TalkControlExecution, TalkControlOperation, TalkControlVerification } from "./types.js";

interface VerificationHost {
  workflowService?: WorkflowService;
}

type VerifyHandler = (
  args: Record<string, unknown>,
  execution: TalkControlExecution,
  host: VerificationHost,
) => TalkControlVerification;

function text(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

const verifyTodo: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  return { ok: !!item, evidence: item ? { id: item.id, version: item.version, status: item.status, assignee: item.assignee } : {} };
};

const verifyEdit: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  const expectedVersion = Number(args.expectedVersion);
  const matches = !!item && [
    item.version === expectedVersion + 1,
    args.title === undefined || item.title === args.title,
    args.body === undefined || item.body === args.body,
    args.priority === undefined || item.priority === args.priority,
  ].every(Boolean);
  return { ok: matches, evidence: item ? { id: item.id, version: item.version, title: item.title, priority: item.priority } : {} };
};

const verifyAssignment: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  return { ok: !!item && item.assignee === text(args, "assignee"), evidence: item ? { id: item.id, version: item.version, assignee: item.assignee } : {} };
};

const verifyComment: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const commentId = String(execution.data.commentId ?? "");
  const comment = listComments(id, { limit: 500 }).comments.find((candidate) => candidate.id === commentId);
  return { ok: !!comment, evidence: comment ? { id: comment.id, workItemId: comment.workItemId } : {} };
};

const verifyDelegation: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const sessionId = String(execution.data.sessionId ?? "");
  const linked = listSessionsByWorkItem(id).some((session) => session.id === sessionId);
  const session = getSession(sessionId);
  const employee = text(args, "employee");
  const item = getWorkItem(id);
  const ok = linked && !!session && session.employee === employee && item?.assignee === employee;
  return { ok, evidence: session ? { todoId: id, sessionId, employee: session.employee, status: session.status } : {} };
};

const verifySession: VerifyHandler = (args) => {
  const id = text(args, "id");
  const session = getSession(id);
  return { ok: !!session, evidence: session ? { sessionId: session.id, status: session.status, messages: getMessages(id).length } : {} };
};

const verifyMessage: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const messageId = String(execution.data.messageId ?? "");
  const message = getMessages(id).find((candidate) => candidate.id === messageId);
  return { ok: !!message, evidence: message ? { sessionId: id, messageId } : {} };
};

const verifyWorkflowRun: VerifyHandler = (args, execution, host) => {
  const id = text(args, "id");
  const runId = text(args, "runId") || String(execution.data.runId ?? "");
  const run = host.workflowService?.getRun(id, runId);
  return { ok: !!run, evidence: run ? { workflowId: id, runId, status: run.status, revision: run.revision } : {} };
};

const verifyWorkflowRuns: VerifyHandler = (args, _execution, host) => {
  const id = text(args, "id");
  const page = host.workflowService?.listRuns(id, { limit: 1 });
  return { ok: !!page, evidence: { workflowId: id, count: page?.items.length ?? 0 } };
};

const VERIFY_HANDLERS: Record<string, VerifyHandler> = {
  read_todo: verifyTodo,
  talk_edit_todo: verifyEdit,
  talk_assign_todo: verifyAssignment,
  talk_comment_todo: verifyComment,
  talk_delegate_todo: verifyDelegation,
  read_session: verifySession,
  talk_send_to_session: verifyMessage,
  talk_start_workflow_run: verifyWorkflowRun,
  read_workflow_run: verifyWorkflowRun,
  read_workflow_runs: verifyWorkflowRuns,
};

export async function verifyTalkDomainOperation(
  operation: TalkControlOperation,
  args: Record<string, unknown>,
  execution: TalkControlExecution,
  host: VerificationHost,
): Promise<TalkControlVerification> {
  const handler = VERIFY_HANDLERS[operation.name];
  return handler ? handler(args, execution, host) : { ok: false, evidence: {} };
}
