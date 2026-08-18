import { describe, expect, it } from "vitest";
import {
  TALK_TOOL_INTENTS,
  allTools,
  alwaysOnTools,
  estimateToolTokens,
  isKnownIntent,
  toolsByName,
  toolsForIntents,
} from "../tools.js";

describe("the tool catalog", () => {
  it("derives the opening set from the authoritative universal catalog", () => {
    const always = alwaysOnTools().map((tool) => tool.name);
    const catalog = allTools().map((tool) => tool.name);
    expect(always.length).toBeGreaterThan(0);
    expect(always).toEqual(catalog);
  });

  it("declares no tool name twice", () => {
    const names = allTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every intent it will answer to", () => {
    expect(TALK_TOOL_INTENTS.length).toBeGreaterThan(0);
    for (const intent of TALK_TOOL_INTENTS) expect(isKnownIntent(intent)).toBe(true);
    expect(isKnownIntent("nonsense")).toBe(false);
  });
});

describe("toolsForIntents", () => {
  it("adds nothing when the universal manifest was exposed at open", () => {
    const added = toolsForIntents(["todos"], alwaysOnTools().map((tool) => tool.name));
    expect(added).toEqual([]);
  });

  it("ignores an unknown intent instead of throwing — the router rejects it first", () => {
    expect(toolsForIntents(["nonsense"], [])).toEqual([]);
  });
});

describe("estimateToolTokens", () => {
  it("reports the non-zero cost of the canonical catalog", () => {
    expect(estimateToolTokens(alwaysOnTools())).toBeGreaterThan(0);
  });

  it("costs nothing for no tools", () => {
    expect(estimateToolTokens([])).toBeGreaterThanOrEqual(0);
  });
});

describe("toolsByName", () => {
  it("resolves exposed names back to declarations for a re-minted token", () => {
    expect(toolsByName(["read_todo", "talk_comment_todo"]).map((tool) => tool.name))
      .toEqual(["read_todo", "talk_comment_todo"]);
  });

  it("drops a name the catalog no longer carries rather than emitting a hole", () => {
    expect(toolsByName(["read_todo", "retired_tool"]).map((tool) => tool.name))
      .toEqual(["read_todo"]);
  });
});
