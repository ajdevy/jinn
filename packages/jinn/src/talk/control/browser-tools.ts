import type { JsonObject } from "../../shared/types.js";
import type { TalkControlOperation, TalkControlParameters } from "./types.js";

const string = (description: string, values?: string[]): JsonObject => ({
  type: "string",
  description,
  ...(values ? { enum: values } : {}),
});

function params(properties: JsonObject, required: string[] = []): TalkControlParameters {
  return { type: "object", properties, required, additionalProperties: false };
}

function browser(
  name: string,
  description: string,
  parameters: TalkControlParameters,
  intent: string,
  mutability: "read" | "effect" = "effect",
): TalkControlOperation {
  return {
    name,
    description,
    parameters,
    target: "browser",
    exposure: "always",
    intent,
    mutability,
    operatorOnly: false,
    verification: "browser-receipt",
  };
}

/** Browser entries are bounded to navigation, focus, resolution, and visual evidence. */
export const BROWSER_CONTROL_OPERATIONS: readonly TalkControlOperation[] = [
  browser("open_todos", "Open the Todo board with optional visible filters.", params({
    board: string("Board scope."),
    status: string("Todo status filter."),
    assignee: string("Assignee filter."),
    department: string("Department filter."),
    source: string("Source filter."),
    label: string("Label filter."),
    due: string("Due window filter."),
    q: string("Title search."),
  }), "todos"),
  browser("open_todo", "Open one Todo by id.", params({ id: string("The full Todo id.") }, ["id"]), "todos"),
  browser("open_chats", "Open chat or a specific session.", params({ sessionId: string("The session id.") }), "sessions"),
  browser("open_workflows", "Open Workflows or one workflow and lens.", params({
    id: string("The workflow id."),
    lens: string("The editor or runs lens.", ["editor", "runs"]),
  }), "workflows"),
  browser("focus_element", "Focus and reveal a safe visible control.", params({ target: string("The semantic control target.") }, ["target"]), "page"),
  browser("resolve_and_open", "Resolve a spoken Todo, chat, Workflow, or Experiment reference and open it.", params({ what: string("The spoken reference.") }, ["what"]), "navigation"),
  browser("capture_current_view", "Capture one bounded image only for a declared semantic visual gap.", params({ reason: string("The declared visual-gap reason.") }, ["reason"]), "visual", "read"),
];
