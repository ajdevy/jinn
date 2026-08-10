import { describe, it, expect } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { isPluginEnabled } from "../enablement.js";

function config(plugins?: JinnConfig["plugins"]): Pick<JinnConfig, "plugins"> {
  return plugins ? { plugins } : {};
}

describe("isPluginEnabled", () => {
  it("enables only what the operator listed", () => {
    expect(isPluginEnabled("inbox", config({ enabled: ["inbox"] }))).toBe(true);
    expect(isPluginEnabled("other", config({ enabled: ["inbox"] }))).toBe(false);
  });

  it.each([
    ["no plugins section", undefined],
    ["empty lists", { enabled: [], disabled: [] }],
    ["a list that names something else", { enabled: ["other"] }],
  ])("treats %s as disabled rather than as unset", (_label, plugins) => {
    expect(isPluginEnabled("inbox", config(plugins))).toBe(false);
  });

  it("lets disabled win over enabled", () => {
    expect(isPluginEnabled("inbox", config({ enabled: ["inbox"], disabled: ["inbox"] }))).toBe(false);
  });

  it("reads a mistyped list as naming nobody", () => {
    const mistyped = { enabled: "inbox" } as unknown as JinnConfig["plugins"];
    expect(isPluginEnabled("inbox", config(mistyped))).toBe(false);
  });
});
