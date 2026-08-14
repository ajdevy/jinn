import { describe, expect, it } from "vitest";
import { deliverableRoute, validateVerifyPolicy } from "../verify-policy.js";

describe("verifyPolicy.deliverable", () => {
  it("accepts the two routes a Todo's product can take", () => {
    for (const deliverable of ["repo", "workspace"] as const) {
      expect(validateVerifyPolicy({ mode: "verify", deliverable })).toEqual({
        ok: true,
        value: { mode: "verify", deliverable },
      });
    }
  });

  it("refuses a route nobody implements, naming the field and the legal values", () => {
    const refused = validateVerifyPolicy({ mode: "verify", deliverable: "elsewhere" });
    expect(refused).toEqual({ ok: false, error: "verifyPolicy.deliverable must be one of repo, workspace" });
  });

  it("leaves an absent deliverable absent, so a Todo written before the field persists unchanged", () => {
    expect(validateVerifyPolicy({ mode: "thorough", maxRounds: 3 })).toEqual({
      ok: true,
      value: { mode: "thorough", maxRounds: 3 },
    });
  });

  it("reads an absent deliverable as repo — for the policy, for no policy, and for no Todo state at all", () => {
    expect(deliverableRoute({ mode: "verify" })).toBe("repo");
    expect(deliverableRoute(null)).toBe("repo");
    expect(deliverableRoute(undefined)).toBe("repo");
    expect(deliverableRoute({ mode: "verify", deliverable: "workspace" })).toBe("workspace");
  });

  it("still refuses a key it does not know, and now says which four it does", () => {
    const refused = validateVerifyPolicy({ mode: "verify", deliverableTo: "workspace" });
    expect(refused).toEqual({
      ok: false,
      error: "verifyPolicy has unknown key(s) deliverableTo; only mode, verifier, maxRounds, and deliverable are allowed",
    });
  });
});
