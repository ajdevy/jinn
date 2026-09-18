import { describe, it, expect } from "vitest";
import { hasOperatorFacingSignal } from "../operator-facing-signal.js";

describe("hasOperatorFacingSignal", () => {
  it("flags an explicit question mark", () => {
    expect(hasOperatorFacingSignal("Should I merge this PR now?")).toBe(true);
  });

  it("flags a decision/blocker phrase without a question mark", () => {
    expect(hasOperatorFacingSignal("Blocked on missing credentials for the deploy")).toBe(true);
    expect(hasOperatorFacingSignal("Waiting on approval before I continue")).toBe(true);
    expect(hasOperatorFacingSignal("This needs a decision before I proceed")).toBe(true);
  });

  it("does not flag a routine status update", () => {
    expect(hasOperatorFacingSignal("Task done, PR #14 merged and deployed.")).toBe(false);
    expect(hasOperatorFacingSignal("Still working on the migration, no blockers.")).toBe(false);
  });

  it("does not flag empty text", () => {
    expect(hasOperatorFacingSignal("")).toBe(false);
  });
});
