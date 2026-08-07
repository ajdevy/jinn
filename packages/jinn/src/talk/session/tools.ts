/**
 * Progressive tool exposure — the main context-cost lever.
 *
 * A realtime session pays for its tool declarations on every turn, so the token
 * minted at open carries a small always-on set and the client asks for a named
 * group once it hears the matching intent.
 *
 * ICI-756 owns the full catalog and extends the groups below. What ships here is
 * the mechanism plus a read-only seed; write actions are ICI-757's.
 */
import type { JsonObject } from "../../shared/types.js";
import type { RealtimeTool } from "../../shared/voice.js";

/** A fresh schema each call: declarations are handed out to callers that may
 *  keep them, so no two tools should share one parameters object. */
function noArguments(): JsonObject {
  return { type: "object", properties: {}, required: [] };
}

const ALWAYS_ON: readonly RealtimeTool[] = [
  {
    name: "search_knowledge",
    description: "Search the company's knowledge and docs for a phrase. Use before answering anything factual about the company.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
  {
    name: "hand_off_to_chat",
    description: "Move a request that is too heavy for voice into a normal text session. Use when the answer needs files, long output, or many steps.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The full request to hand to the text session." } },
      required: ["prompt"],
    },
  },
];

const GROUPS: Record<string, readonly RealtimeTool[]> = {
  todos: [
    {
      name: "list_work_items",
      description: "List Todos, optionally filtered by status or assignee.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Status to filter by, e.g. executing or in_review." },
          assignee: { type: "string", description: "Employee name to filter by." },
        },
        required: [],
      },
    },
    {
      name: "get_work_item",
      description: "Read one Todo in full, including its activity and comments.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Todo id, e.g. ABC-123." } },
        required: ["id"],
      },
    },
  ],
  sessions: [
    {
      name: "list_sessions",
      description: "List recent sessions and their status.",
      parameters: noArguments(),
    },
    {
      name: "read_session",
      description: "Read the latest messages of one session.",
      parameters: {
        type: "object",
        properties: { sessionId: { type: "string", description: "Session id to read." } },
        required: ["sessionId"],
      },
    },
  ],
  org: [
    {
      name: "list_employees",
      description: "List the employees in the organization with their department and rank.",
      parameters: noArguments(),
    },
    {
      name: "get_employee",
      description: "Read one employee's full persona and reporting line.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Employee name, e.g. a-lead." } },
        required: ["name"],
      },
    },
  ],
};

/** Intent names `toolsForIntents` accepts. Anything else is a client bug. */
export const TALK_TOOL_INTENTS = Object.keys(GROUPS);

export function alwaysOnTools(): RealtimeTool[] {
  return ALWAYS_ON.map((tool) => ({ ...tool }));
}

/** Every tool in the catalog, always-on set included. */
export function allTools(): RealtimeTool[] {
  return [...ALWAYS_ON, ...Object.values(GROUPS).flat()].map((tool) => ({ ...tool }));
}

export function isKnownIntent(intent: string): boolean {
  return intent in GROUPS;
}

/**
 * The tools an intent adds that are not exposed yet. Asking twice for the same
 * intent returns an empty array rather than a duplicate declaration, because the
 * provider rejects a session carrying two tools of the same name.
 */
export function toolsForIntents(intents: readonly string[], exposedNames: readonly string[]): RealtimeTool[] {
  const exposed = new Set(exposedNames);
  const added: RealtimeTool[] = [];
  for (const intent of intents) {
    for (const tool of GROUPS[intent] ?? []) {
      if (exposed.has(tool.name)) continue;
      exposed.add(tool.name);
      added.push({ ...tool });
    }
  }
  return added;
}

/** Estimated context cost of a tool list: its JSON at 4 characters per token.
 *  An estimate, not the provider's count — it exists to make the cost of adding
 *  a group visible, not to bill anyone. */
export function estimateToolTokens(tools: readonly RealtimeTool[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

/** Look up exposed tool names, for re-minting a token mid-session. */
export function toolsByName(names: readonly string[]): RealtimeTool[] {
  const catalog = new Map(allTools().map((tool) => [tool.name, tool]));
  return names.flatMap((name) => {
    const tool = catalog.get(name);
    return tool ? [tool] : [];
  });
}
