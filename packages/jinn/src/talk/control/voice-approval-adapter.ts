import { initDb } from "../../shared/db.js";
import { currentApproval } from "../../work-items/approval-rows.js";
import { decideWorkItemApprovalSync } from "../../work-items/approvals.js";
import { getWorkItem } from "../../work-items/store.js";
import { TalkApprovalRepository } from "../approval/repository.js";
import { TalkApprovalService, type TodoApprovalSnapshot } from "../approval/service.js";
import { TalkControlRefusal, type TalkControlAdapterContext, type TalkControlExecution } from "./types.js";

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function approvalService(): TalkApprovalService {
  const snapshot = (id: string): TodoApprovalSnapshot | null => {
    const item = getWorkItem(id);
    const approval = item ? currentApproval(item.id) : undefined;
    if (!item || !approval) return null;
    return {
      todoId: item.id,
      todoVersion: item.version,
      approvalId: approval.id,
      request: approval.request,
      options: approval.options,
      state: approval.state,
    };
  };
  return new TalkApprovalService({
    repository: new TalkApprovalRepository(initDb()),
    todo: {
      snapshot,
      decide: (input) => {
        const result = decideWorkItemApprovalSync({
          id: input.id,
          decision: input.decision,
          choice: input.choice,
          decidedBy: "operator",
        });
        return result.ok
          ? { ok: true, version: result.item.version }
          : { ok: false, code: result.code, message: result.message };
      },
    },
  });
}

function requireApprovalEvidence(call: TalkControlAdapterContext): asserts call is TalkControlAdapterContext & {
  browserInstanceId: string;
  credentialGeneration: number;
  providerTranscriptItemId: string;
} {
  if (!call.browserInstanceId || !call.credentialGeneration || !call.providerTranscriptItemId) {
    throw new TalkControlRefusal("approval-evidence-required", "Voice approval requires bound final transcript evidence.");
  }
}

export function executeVoiceApproval(
  operation: "prepare" | "commit",
  args: Record<string, unknown>,
  call: TalkControlAdapterContext,
): TalkControlExecution {
  requireApprovalEvidence(call);
  const evidence = {
    talkSessionId: call.talkSessionId,
    browserInstanceId: call.browserInstanceId,
    credentialGeneration: call.credentialGeneration,
    providerCallId: call.providerCallId,
    ...(call.providerItemId ? { providerToolItemId: call.providerItemId } : {}),
    ...(call.providerEventId ? { providerToolEventId: call.providerEventId } : {}),
    providerTranscriptItemId: call.providerTranscriptItemId,
    caller: call.caller,
  };

  if (operation === "prepare") {
    const result = approvalService().prepareTodo({ ...evidence, todoId: requiredText(args, "id") });
    if (!result.ok) throw new TalkControlRefusal(result.code, result.error);
    return { data: result, uiEffect: null };
  }

  const result = approvalService().commitTodo({ ...evidence, challengeId: requiredText(args, "challengeId") });
  if (!result.ok) throw new TalkControlRefusal(result.code, result.error);
  return {
    data: result,
    uiEffect: {
      invalidate: ["todos", `todo:${result.todoId}`],
      navigate: `/todos/${encodeURIComponent(result.todoId)}`,
    },
  };
}
