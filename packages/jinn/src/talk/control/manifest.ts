import type { JsonObject } from "../../shared/types.js";
import { BROWSER_CONTROL_OPERATIONS } from "./browser-tools.js";
import type { TalkControlManifest, TalkControlOperation, TalkControlParameters } from "./types.js";

const string = (description: string): JsonObject => ({ type: "string", description });
const integer = (description: string): JsonObject => ({ type: "integer", description });

function params(properties: JsonObject, required: string[] = []): TalkControlParameters {
  return { type: "object", properties, required, additionalProperties: false };
}

function gateway(
  name: string,
  description: string,
  parameters: TalkControlParameters,
  intent: string,
  policy: { mutability: "read" | "write"; verification: string },
): TalkControlOperation {
  return {
    name,
    description,
    parameters,
    target: "gateway",
    exposure: "always",
    intent,
    mutability: policy.mutability,
    operatorOnly: policy.mutability === "write",
    verification: policy.verification,
  };
}

const GATEWAY_OPERATIONS: readonly TalkControlOperation[] = [
  gateway("read_todo", "Read one Todo from the authoritative ledger.", params({ id: string("The full Todo id.") }, ["id"]), "todos", { mutability: "read", verification: "todo-reread" }),
  gateway("talk_edit_todo", "Edit a Todo title, body, or priority using its current version.", params({
    id: string("The full Todo id."),
    expectedVersion: integer("The Todo version currently shown."),
    title: string("A replacement title."),
    body: string("A replacement body."),
    priority: integer("Priority from 0 through 3."),
  }, ["id", "expectedVersion"]), "todos", { mutability: "write", verification: "todo-version-reread" }),
  gateway("talk_comment_todo", "Add one operator comment to a Todo.", params({ id: string("The full Todo id."), body: string("The comment body.") }, ["id", "body"]), "todos", { mutability: "write", verification: "comment-reread" }),
  gateway("talk_assign_todo", "Assign a Todo to a named employee.", params({ id: string("The full Todo id."), assignee: string("The employee slug.") }, ["id", "assignee"]), "todos", { mutability: "write", verification: "todo-assignment-reread" }),
  gateway("prepare_voice_approval", "Prepare a short-lived approval challenge for one Todo. This never decides it.", params({ id: string("The full Todo id.") }, ["id"]), "todos", { mutability: "write", verification: "approval-challenge-reread" }),
  gateway("commit_voice_approval", "Commit a prepared challenge from the separately recorded final operator utterance. Arguments contain only the challenge id.", params({ challengeId: string("The prepared challenge id.") }, ["challengeId"]), "todos", { mutability: "write", verification: "approval-decision-reread" }),
  gateway("talk_delegate_todo", "Delegate an existing Todo to a named employee and open its resulting chat.", params({
    id: string("The full Todo id."),
    employee: string("The employee slug."),
    task: string("The full delegation brief."),
  }, ["id", "employee"]), "delegation", { mutability: "write", verification: "todo-session-link-reread" }),
  gateway("read_session", "Read one chat session and its recent messages.", params({ id: string("The session id.") }, ["id"]), "sessions", { mutability: "read", verification: "session-reread" }),
  gateway("talk_send_to_session", "Send one operator message into a chat session.", params({ id: string("The session id."), message: string("The operator message.") }, ["id", "message"]), "sessions", { mutability: "write", verification: "message-reread" }),
  gateway("talk_start_workflow_run", "Start one enabled manual Workflow run.", params({ id: string("The workflow id."), input: string("Optional JSON object input.") }, ["id"]), "workflows", { mutability: "write", verification: "workflow-run-reread" }),
  gateway("read_workflow_runs", "Read recent runs of one Workflow.", params({ id: string("The workflow id."), limit: integer("Maximum runs to return.") }, ["id"]), "workflows", { mutability: "read", verification: "workflow-runs-reread" }),
  gateway("read_workflow_run", "Read one exact Workflow run.", params({ id: string("The workflow id."), runId: string("The run id.") }, ["id", "runId"]), "workflows", { mutability: "read", verification: "workflow-run-reread" }),
  gateway("talk_recall_topic", "Resolve a vague reference to an earlier Talk topic. Returns candidates instead of guessing when ambiguous.", params({ reference: string("The operator's reference, such as 'the first one' or 'the release workflow'.") }, ["reference"]), "memory", { mutability: "read", verification: "topic-resolution-reread" }),
  gateway("talk_remember_topic", "Save an explicit goal, decision, or unresolved question on the current Talk topic.", params({
    topicId: string("Optional exact topic id; omit to use the current topic."),
    goal: string("The durable goal."),
    decision: string("One durable decision."),
    unresolvedQuestion: string("One open question."),
    resolvedQuestion: string("An exact open question that is now resolved."),
  }), "memory", { mutability: "write", verification: "topic-commitment-reread" }),
];

const MANIFEST: TalkControlManifest = {
  version: 1,
  operations: [...GATEWAY_OPERATIONS, ...BROWSER_CONTROL_OPERATIONS],
};

/** Return a detached public copy so callers cannot mutate the process catalog. */
export function buildTalkControlManifest(): TalkControlManifest {
  return structuredClone(MANIFEST);
}

export function operationByName(manifest: TalkControlManifest, name: string): TalkControlOperation | undefined {
  return manifest.operations.find((operation) => operation.name === name);
}
