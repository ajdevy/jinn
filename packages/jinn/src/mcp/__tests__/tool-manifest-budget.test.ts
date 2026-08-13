import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";
import { EXPECTED_ENUMS, EXPECTED_REQUIRED, EXPECTED_TOOL_NAMES } from "./tool-manifest-expectations.js";

// Fixed provider budget. Rebased for the experiment Todo link with the same
// ~zero headroom discipline as before: new tool prose must stay concise rather
// than growing into this ceiling.
const MAX_MANIFEST_TOKENS = 5743;
// Exact gate: js-tiktoken 1.0.21 with its local o200k_base ranks. The provider
// projection is the OpenAI Responses API function-tool request shape pinned on 2026-07-12.
const ATTESTED = {
  // Rebased for `create_label`, `labels` on create_work_item, and `view` on
  // get_workflow_run (95 tokens, bought back by cutting four dead clauses).
  // Rebased again for `operatorOnly` on request_work_item_approval — the flag
  // that reserves a Todo gate for the human operator. It costs 8 tokens and
  // leaves Pi 9 under the ceiling, down from 17. The next addition to this
  // surface has to buy its own room back; there is no longer slack to spend.
  // Rebased for `assigned` on update_work_item's status enum: the agent lane
  // can now put a Todo back in the queue. It costs 2 tokens and leaves Pi 7
  // under the ceiling, down from 9.
  // Rebased once more for `asOperator` on update_work_item, which costs 24 and
  // broke the ceiling. Three dead clauses bought it back:
  //   - "Match role/persona fit;" on spawn_session — its own `employee` field
  //     already teaches the selection rule, one line below.
  //   - the field list on list_employees ("name, role, rank, department,
  //     engine, reporting") — the rows it describes carry their own keys. The
  //     part worth saying, that they include reporting lines, stays.
  //   - "Include own session." on search_messages — the property name says it,
  //     and the tool description already states the default it flips.
  // Rebased for `title` on edit_work_item, now that a Todo's content is open to
  // every session. It costs 9 tokens; the tool's own description bought 10 back
  // by dropping the field list ("Edit Todo title, body, acceptance, priority, or
  // dueAt.") that its schema properties already enumerate.
  // Rebased for `backlog` on update_work_item's status enum: "not now" is a
  // legitimate agent move. It costs 3 tokens and leaves Pi 3 under the ceiling.
  // Rebased for read_session's full-body and last=0 transcript contract. Its
  // concise field prose keeps Pi one token under the fixed ceiling.
  // Reattested for list_sessions' `pinned` scope. The new enum value spent
  // tokens; shortening its redundant description from an enumeration of the
  // same scopes to "by scope" bought those back plus four,
  // leaving Pi five under the unchanged ceiling.
  // Rebased for the six-tool Experiments ledger. This is a new public company
  // block rather than prose growth on an existing tool; Pi remains five tokens
  // under the fixed ceiling.
  // Rebased for the three-tool heartbeats group (arm/list/stop). Like the
  // Experiments ledger this is a new public capability rather than prose growth
  // on an existing tool, and unlike the earlier rebases there was no dead prose
  // left to buy it back with: its own descriptions were tightened first (19
  // tokens), and the remaining 175 are the group's honest cost. Pi stays five
  // under the ceiling, so the next addition still has to pay its own way.
  // Rebased for the Experiments audit fixes: `limit` on list_experiments and
  // `baseline` plus the one line teaching that a new metric needs one on
  // update_experiment — the client halves of the bounded list and the
  // baseline-on-update fix, without which an agent editing metrics just gets
  // `invalid`. Two redundant clauses bought 7 of the 24 back: "optionally by
  // status" on list_experiments, whose property carries its own enum and now
  // sits beside `limit`, and "'s definition"/"here" on update_experiment. The
  // remaining 17 are the fixes' honest cost. Pi stays five under the ceiling.
  // Rebased for `todoId` and `owner` on create_experiment and update_experiment:
  // the fields that stop an experiment being an island with no owner and no link
  // to the work it informs. Four schema properties and not one word of prose —
  // both tool descriptions are byte-for-byte what they were, because the property
  // names say what they are and `["string","null"]` on the update pair says that
  // null clears them. Create declares plain strings: there is nothing to clear at
  // creation. That leaves 35 tokens with nothing dead left in this group to buy
  // them back from, so the ceiling moves by exactly that. Pi stays five under it.
  // Rebased for `blockKind` on update_work_item: the four-value enum that says
  // WHY a Todo is blocked, and with it where the block lands. It has to be on
  // the tool rather than inferred, because `dependency` returns the Todo to its
  // queue while the other three park it in front of a human, and a caller that
  // cannot say which gets the human every time. The enum plus its one clause of
  // routing prose cost 39; its own description already paid 3 of that back by
  // dropping "Why blocked.", which the property name says. Nothing dead is left
  // in this group to buy the rest from, so the ceiling moves by exactly the 39.
  // Pi stays five under it.
  rpc: { tokens: 5240, sha256: "378398b6c24f73594560a6b2ae0ebd91e45d6641bf4bd6f6226d07fbf49112b5" },
  pi: { tokens: 5738, sha256: "6401ace1a1278ac0b1232307ff4d47f43cc33371b155ecf3a6edc985ab6f735d" },
  openai: { tokens: 5442, sha256: "b59b7f5da754408831dc4cff9d346adf957f3021fbc33f2ea3d57e8c1af90c64" },
} as const;

type TokenizerLoader = () => Promise<[{ Tiktoken: typeof import("js-tiktoken/lite").Tiktoken }, { default: typeof import("js-tiktoken/ranks/o200k_base").default }]>;
const loadPinnedTokenizer: TokenizerLoader = () => Promise.all([
  import("js-tiktoken/lite"),
  import("js-tiktoken/ranks/o200k_base"),
]);

async function exactOrAttested(name: keyof typeof ATTESTED, payload: string, loadTokenizer: TokenizerLoader = loadPinnedTokenizer): Promise<number> {
  try {
    const [{ Tiktoken }, ranks] = await loadTokenizer();
    return new Tiktoken(ranks.default).encode(payload).length;
  } catch {
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    if (hash !== ATTESTED[name].sha256) throw new Error(`tokenizer unavailable and ${name} manifest is not the attested golden payload (${hash})`);
    return ATTESTED[name].tokens;
  }
}

function collectEnums(value: unknown, path: string[] = []): Array<[string, string[]]> {
  if (!value || typeof value !== "object") return [];
  const schema = value as Record<string, unknown>;
  const own = Array.isArray(schema.enum) ? ([[path.join("."), schema.enum as string[]]] as Array<[string, string[]]>) : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) => collectEnums(child, [...path, key])),
  ];
}

describe("tool manifest budget", () => {
  it(`keeps exact JSON-RPC, owned Pi, and pinned OpenAI wrapper manifests under ${MAX_MANIFEST_TOKENS} o200k_base tokens`, async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const wrappers = {
      rpc: { jsonrpc: "2.0", id: 1, result: { tools } },
      pi: { tools: projectPiToolManifest(tools) },
      // Pinned provider fixture: OpenAI Responses API function tool shape (2026-07-12).
      openai: { tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, parameters: inputSchema })) },
    } as const;
    for (const [name, wrapper] of Object.entries(wrappers) as Array<[keyof typeof wrappers, unknown]>) {
      expect(await exactOrAttested(name, JSON.stringify(wrapper))).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    }
  }, 15_000);

  it("fails closed when a 350-character manifest mutation exceeds the cap", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const prose = sentence.repeat(4).slice(0, 350);
    expect(prose).toHaveLength(350);
    const mutated = { tools: projectPiToolManifest(tools), mutation: prose };
    expect(await exactOrAttested("pi", JSON.stringify(mutated))).toBeGreaterThan(MAX_MANIFEST_TOKENS);
  });

  it("uses attestation only for the unchanged golden when the pinned tokenizer is unavailable", async () => {
    const unavailable: TokenizerLoader = async () => { throw new Error("simulated unavailable tokenizer"); };
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const golden = JSON.stringify({ tools: projectPiToolManifest(tools) });
    expect(await exactOrAttested("pi", golden, unavailable)).toBe(ATTESTED.pi.tokens);

    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const changed = JSON.stringify({ tools: projectPiToolManifest(tools), mutation: sentence.repeat(4).slice(0, 350) });
    await expect(exactOrAttested("pi", changed, unavailable)).rejects.toThrow(/not the attested golden payload/);
  });

  it("keeps tool names, required arrays, and enum arrays stable", () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(tools).toHaveLength(72);

    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toEqual(EXPECTED_REQUIRED);

    const enums = Object.fromEntries(
      tools
        .map((t) => [t.name, collectEnums(t.inputSchema)] as const)
        .filter(([, entries]) => entries.length > 0),
    );
    expect(enums).toEqual(EXPECTED_ENUMS);
  });
});
