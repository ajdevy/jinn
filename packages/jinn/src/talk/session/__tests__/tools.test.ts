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
  it("keeps the always-on set a strict subset of the catalog", () => {
    const always = alwaysOnTools().map((tool) => tool.name);
    const catalog = allTools().map((tool) => tool.name);
    expect(always.length).toBeGreaterThan(0);
    expect(always.length).toBeLessThan(catalog.length);
    for (const name of always) expect(catalog).toContain(name);
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
  it("adds an intent's tools when none are exposed yet", () => {
    const added = toolsForIntents(["todos"], alwaysOnTools().map((tool) => tool.name));
    expect(added.map((tool) => tool.name)).toEqual(["list_work_items", "get_work_item"]);
  });

  it("adds nothing the second time the same intent is asked for", () => {
    const exposed = alwaysOnTools().map((tool) => tool.name);
    const first = toolsForIntents(["todos"], exposed);
    exposed.push(...first.map((tool) => tool.name));
    expect(toolsForIntents(["todos"], exposed)).toEqual([]);
  });

  it("does not repeat a tool when one call names an intent twice", () => {
    const added = toolsForIntents(["todos", "todos"], []);
    const names = added.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("ignores an unknown intent instead of throwing — the router rejects it first", () => {
    expect(toolsForIntents(["nonsense"], [])).toEqual([]);
  });
});

describe("estimateToolTokens", () => {
  it("grows strictly when a group is added, which is the point of the lever", () => {
    const always = alwaysOnTools();
    const withTodos = [...always, ...toolsForIntents(["todos"], always.map((tool) => tool.name))];
    expect(estimateToolTokens(withTodos)).toBeGreaterThan(estimateToolTokens(always));
  });

  it("costs nothing for no tools", () => {
    expect(estimateToolTokens([])).toBeGreaterThanOrEqual(0);
  });
});

describe("toolsByName", () => {
  it("resolves exposed names back to declarations for a re-minted token", () => {
    expect(toolsByName(["search_knowledge", "get_work_item"]).map((tool) => tool.name))
      .toEqual(["search_knowledge", "get_work_item"]);
  });

  it("drops a name the catalog no longer carries rather than emitting a hole", () => {
    expect(toolsByName(["search_knowledge", "retired_tool"]).map((tool) => tool.name))
      .toEqual(["search_knowledge"]);
  });
});
