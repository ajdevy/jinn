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
  gateway("read_talk_capability", "Read whether a company capability is supported or return its exact named gap and planned adapter. Known lanes include todos, chats, workflows, notes, experiments, cron, org, skills, settings, logs, files, instances, approvals, topics, and screen navigation.", params({
    capability: string("The exact capability key from the Talk company inventory."),
  }, ["capability"]), "capabilities", { mutability: "read", verification: "capability-inventory-reread" }),
];

const MANIFEST: TalkControlManifest = {
  version: 1,
  operations: [...GATEWAY_OPERATIONS, ...BROWSER_CONTROL_OPERATIONS],
};

export type TalkCompanyCapabilityCoverage =
  | { status: "supported"; operations: readonly string[]; evidence: string }
  | { status: "explicit-gap"; reason: string; plannedAdapter: string };

/**
 * Company controls are deliberately inventoried separately from route context.
 * Seeing a surface never implies that Talk can mutate it. Supported entries
 * name exact manifest operations; every other company lane has a stable gap id
 * and the canonical adapter seam it still needs.
 */
export const TALK_COMPANY_CAPABILITY_COVERAGE = {
  "todo-core": {
    status: "supported",
    operations: ["read_todo", "talk_edit_todo", "talk_comment_todo", "talk_assign_todo", "talk_delegate_todo"],
    evidence: "authoritative Todo, comment, assignment, and linked-session rereads",
  },
  "todo-extended": {
    status: "explicit-gap",
    reason: "todo-extended-command-adapter-missing",
    plannedAdapter: "reuse create, transition, label, relation, attachment, and comment-delete commands",
  },
  "chat-core": {
    status: "supported",
    operations: ["read_session", "talk_search_chat_messages", "talk_draft_reply", "talk_replace_draft", "talk_send_draft", "talk_draft_and_send", "talk_send_to_session"],
    evidence: "bounded current-chat excerpts, visible-composer receipts, and named-session consent",
  },
  "chat-lifecycle": {
    status: "explicit-gap",
    reason: "chat-lifecycle-command-adapter-missing",
    plannedAdapter: "reuse create, rename, archive, duplicate, delete, queue, stop, and reset commands",
  },
  delegation: {
    status: "supported",
    operations: ["talk_delegate_todo"],
    evidence: "Todo-to-session link, child session, and dispatch rereads",
  },
  "workflow-core": {
    status: "supported",
    operations: ["talk_start_workflow_run", "read_workflow_runs", "read_workflow_run"],
    evidence: "workflow-run repository rereads",
  },
  "workflow-authoring-and-gates": {
    status: "explicit-gap",
    reason: "workflow-command-adapter-missing",
    plannedAdapter: "reuse definition edits, run cancellation, input gates, and workflow approval commands",
  },
  "voice-approval": {
    status: "supported",
    operations: ["prepare_voice_approval", "commit_voice_approval"],
    evidence: "operator-bound challenge, provider transcript identity, target revision, and durable decision audit",
  },
  "topic-memory": {
    status: "supported",
    operations: ["talk_recall_topic", "talk_remember_topic"],
    evidence: "durable topic commitments, candidates, navigation, and source rehydration",
  },
  "screen-navigation-and-visual": {
    status: "supported",
    operations: BROWSER_CONTROL_OPERATIONS
      .filter((operation) => !new Set([
        "talk_search_chat_messages", "talk_draft_reply", "talk_replace_draft",
        "talk_send_draft", "talk_draft_and_send", "talk_send_to_session",
      ]).has(operation.name))
      .map((operation) => operation.name),
    evidence: "browser receipt, awaited UI effect, or bounded sanitized visual receipt",
  },
  "capability-inventory": {
    status: "supported",
    operations: ["read_talk_capability"],
    evidence: "typed manifest-backed supported operation or exact gap id and planned adapter",
  },
  notes: {
    status: "explicit-gap",
    reason: "notes-command-adapter-missing",
    plannedAdapter: "reuse managed note list, read, create, and update commands",
  },
  experiments: {
    status: "explicit-gap",
    reason: "experiments-command-adapter-missing",
    plannedAdapter: "reuse experiment create, reading, conclude, and reopen commands",
  },
  cron: {
    status: "explicit-gap",
    reason: "cron-command-adapter-missing",
    plannedAdapter: "reuse cron update, enable, disable, trigger, and run-inspection commands",
  },
  org: {
    status: "explicit-gap",
    reason: "org-command-adapter-missing",
    plannedAdapter: "reuse employee read, editable-field update, delegation, and session commands",
  },
  skills: {
    status: "explicit-gap",
    reason: "skills-command-adapter-missing",
    plannedAdapter: "reuse managed skill read and update commands with exact content confirmation",
  },
  "settings-and-plugins": {
    status: "explicit-gap",
    reason: "settings-plugins-command-adapter-missing",
    plannedAdapter: "reuse safe config and guarded plugin lifecycle commands without exposing secrets",
  },
  "logs-and-limits": {
    status: "explicit-gap",
    reason: "logs-limits-command-adapter-missing",
    plannedAdapter: "reuse bounded redacted log queries and engine-limit refresh commands",
  },
  "managed-files": {
    status: "explicit-gap",
    reason: "managed-files-command-adapter-missing",
    plannedAdapter: "reuse allowed-home list, read, publish, and attach commands",
  },
  "instances-and-onboarding": {
    status: "explicit-gap",
    reason: "instance-onboarding-command-adapter-missing",
    plannedAdapter: "reuse guarded instance and onboarding commands with exact scope confirmation",
  },
  "company-read-lanes": {
    status: "explicit-gap",
    reason: "company-read-lanes-adapter-missing",
    plannedAdapter: "reuse knowledge, search, cost, connector, heartbeat, and managed approval reads",
  },
} as const satisfies Readonly<Record<string, TalkCompanyCapabilityCoverage>>;

export function validateTalkCompanyCoverage(
  manifest: TalkControlManifest = MANIFEST,
  coverage: Readonly<Record<string, TalkCompanyCapabilityCoverage>> = TALK_COMPANY_CAPABILITY_COVERAGE,
): string[] {
  const declared = new Set(manifest.operations.map((operation) => operation.name));
  return Object.entries(coverage).flatMap(([capability, entry]) => {
    if (entry.status === "explicit-gap") {
      return entry.reason && entry.plannedAdapter ? [] : [`incomplete explicit gap: ${capability}`];
    }
    if (!entry.operations.length || !entry.evidence) return [`incomplete supported capability: ${capability}`];
    return entry.operations.filter((operation) => !declared.has(operation))
      .map((operation) => `unknown manifest operation for ${capability}: ${operation}`);
  });
}

export function renderTalkCompanyCoverageMarkdown(
  coverage: Readonly<Record<string, TalkCompanyCapabilityCoverage>> = TALK_COMPANY_CAPABILITY_COVERAGE,
): string {
  const rows = Object.entries(coverage).map(([capability, entry]) => entry.status === "supported"
    ? `| ${capability} | supported | ${entry.operations.join(", ")} | ${entry.evidence} |`
    : `| ${capability} | explicit gap | — | ${entry.reason}; ${entry.plannedAdapter} |`);
  return [
    "## Company capability inventory",
    "",
    "> Generated from `TALK_COMPANY_CAPABILITY_COVERAGE`. A semantic route never implies mutation authority.",
    "",
    "| Capability | Status | Manifest operations | Verification or planned seam |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Return a detached public copy so callers cannot mutate the process catalog. */
export function buildTalkControlManifest(): TalkControlManifest {
  return structuredClone(MANIFEST);
}

export function operationByName(manifest: TalkControlManifest, name: string): TalkControlOperation | undefined {
  return manifest.operations.find((operation) => operation.name === name);
}
