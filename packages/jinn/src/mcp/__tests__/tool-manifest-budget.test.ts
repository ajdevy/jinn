import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";
import { EXPECTED_ENUMS, EXPECTED_REQUIRED, EXPECTED_TOOL_NAMES } from "./tool-manifest-expectations.js";

// Fixed provider budget. Rebased for the experiment Todo link with the same
// ~zero headroom discipline as before: new tool prose must stay concise rather
// than growing into this ceiling.
const MAX_MANIFEST_TOKENS = 5932;
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
  // Rebased for `set_work_item_dispatch` and `idempotencyKey` on
  // create_work_item (ICI-733): how a Todo's next attempt runs, and a
  // caller-supplied create key. Like the Experiments ledger and the heartbeats
  // group before it, this is a new public capability rather than prose growth on
  // an existing tool, and there was no dead prose left in this group to buy it
  // back with — its own description was tightened first ("and an engine/model
  // override" to "engine/model override", "while it is executing" to "while
  // executing"), and the remaining 126 are the addition's honest cost. Pi stays
  // five under the ceiling, so the next addition still has to pay its own way.
  // Rebased for `cascade` and `acknowledgeEscalated` on update_work_item
  // (PLA-96): closing a container and its open sub-tasks in one move, and the
  // separate word that lets that run over an escalated sub-task. Both have to be
  // on the tool — the route refuses a cascade it was not asked for, and refuses
  // one over an escalation until the caller says so, and a caller that cannot
  // say either has to close a dozen sub-tasks one at a time. Their prose was cut
  // to one clause each first ("the Todo's" to "its"; the repeated "Operator
  // surface only." dropped from the second, where the first already says it),
  // which paid 8 of the cost back. Nothing dead is left in this group to buy the
  // remaining 49 from, so the ceiling moves by exactly that. Pi stays five under.
  // Rebased for `offset` on read_knowledge and the cap it now names (PLA-100).
  // Both have to be on the tool: an agent that cannot see the boundary reads a
  // truncated file believing it whole, and one that cannot page has no way to
  // reach the rest. Its own description paid 2 back first ("N chars at a time;
  // page the rest with offset" to "N chars per call; offset pages the rest"),
  // and nothing dead is left in this group to buy the remaining 14 from, so the
  // ceiling moves by exactly that. Pi stays five under it.
  // Reattested for `verifyPolicy` on update_work_item (PLA-102): a Todo whose
  // product lands in the operator's workspace rather than in the diff has to be
  // able to say so on the tool that moves it, or the route is one the web
  // surface can declare and an agent cannot. It is a bare `{"type":"object"}`
  // and not one word of prose — the shared validator names every legal shape in
  // its refusal — so its whole cost is 7 tokens on each of the three wrappers.
  // It buys them back rather than moving the ceiling: `cost_report.groupBy`
  // carried the description "employee or day.", which is its own enum
  // `["employee","day"]` written out a second time in English, and dropping it
  // pays exactly 7 on each wrapper. So the ceiling, all three totals, and the
  // tool count are what `main` pinned; only the payload moved, so only the SHAs
  // do.
  // Reattested for `choice` on decide_workflow_approval (PLA-133): without it an
  // approval gate that offers variants is undecidable from MCP at all, because
  // approving one without naming a pick is refused rather than defaulted. The
  // bare `{"type":"string"}` costs 7 and not one word of prose. Two restatements
  // of an enum already in the schema bought 4 of that back, the same trade
  // `cost_report.groupBy` made: "Approve or reject" on this very tool, whose
  // `decision` enum is `["approve","reject"]`, and "with the original or current
  // definition" on rerun_workflow_run, whose `definition` enum is
  // `["original","current"]`. The remaining 3 fit under the unchanged ceiling —
  // Pi sits two below it, so the next addition still has to pay its own way.
  rpc: { tokens: 5424, sha256: "91d3619df025c1caae8310453fab4d18d546922cf1c1c784d535420d0297541d" },
  pi: { tokens: 5930, sha256: "a626d94d3e049c62ef5c4fb8c747235aeddeaf5886f9aef1894bd8bec79e1d6c" },
  openai: { tokens: 5629, sha256: "968b132e47eee9c3ef06b953d90a085e72d6262407f144913f2340e8a97b12b2" },
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
    expect(tools).toHaveLength(73);

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
