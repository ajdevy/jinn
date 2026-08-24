import { describe, expect, it } from "vitest";
import { classifyRecovery } from "../recovery.js";

/**
 * PLA-240 replay: the audit's representative incidents, written as classifier
 * contracts before any recovery writes exist. Generic fixture ids only.
 */

describe("historical incident replay — classifier", () => {
  it("transient quota block classifies as recovering, not operator", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-1", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "rate_limited",
        error: "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      labels: ["build"],
    });
    expect(verdict).toMatchObject({ class: "transient", lane: "recovering" });
  });

  it("code failure routes to manager, not operator", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-2", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "crashed",
        error: "the build step exited with code 1",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      labels: ["build"],
    });
    expect(verdict).toMatchObject({ class: "code", lane: "manager" });
  });

  it("verification failure routes to the independent verifier lane", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-3", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "failed",
        error: "independent review rejected the diff",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      labels: ["build"],
      verifyMode: "thorough",
    });
    expect(verdict).toMatchObject({ class: "verification", lane: "manager" });
  });

  it("security/auth-terminal is manager, not a clock retry", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-4", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "crashed",
        error: "401 Unauthorized: invalid api key",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      labels: ["build"],
    });
    expect(verdict).toMatchObject({ class: "security", lane: "manager" });
  });

  it("operator-only pending approval is Needs you", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-5", status: "in_review", assignee: "platform-worker", source: "session" },
      approval: { state: "pending", operatorOnly: true },
      labels: ["build"],
    });
    expect(verdict).toMatchObject({ class: "operator", lane: "operator" });
  });

  it("ordinary backlog never classifies as recovering", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-6", status: "backlog", assignee: null, source: "human" },
      labels: [],
    });
    expect(verdict.lane).not.toBe("recovering");
    expect(verdict.class).toBe("operator");
  });

  it("an approved completed leftover still in_review is Manager attention, not Needs you", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-15", status: "in_review", assignee: "platform-worker", source: "workflow" },
      lastRun: {
        id: "run_landed",
        outcome: "completed",
        error: null,
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      approval: { state: "approved", operatorOnly: false },
      labels: ["build"],
    });
    expect(verdict).toMatchObject({ lane: "manager" });
    expect(verdict.lane).not.toBe("operator");
  });
});
