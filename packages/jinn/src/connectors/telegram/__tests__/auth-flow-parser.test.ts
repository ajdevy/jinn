import { describe, expect, it } from "vitest";
import { parseAuthCommand, redactAuthOutput } from "../auth-flow.js";

describe("parseAuthCommand", () => {
  it("parses only supported auth commands and rejects token variants", () => {
    expect(parseAuthCommand("/auth_claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth_codex@jinn_bot")).toEqual({
      kind: "start",
      provider: "codex",
    });
    expect(parseAuthCommand("/auth_status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth_cancel")).toEqual({ kind: "cancel" });
    expect(parseAuthCommand("/auth claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth@jinn codex")).toEqual({ kind: "start", provider: "codex" });
    expect(parseAuthCommand("/auth status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth cancel")).toEqual({ kind: "cancel" });
    expect(parseAuthCommand("/auth input AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input=AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth_input:AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input bad-code")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth_token: never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth access-token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth input ab12-cd34")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("hello")).toBeNull();
  });
});
describe("redactAuthOutput", () => {
  it("redacts URLs, bearer values, JWTs, and one-time codes", () => {
    const safe = redactAuthOutput(
      "Open https://auth.example.test/callback?state=secret-state code AB12-CD34 Bearer eyJsecret abc.def.ghi",
    );

    expect(safe).not.toContain("auth.example.test");
    expect(safe).not.toContain("secret-state");
    expect(safe).not.toContain("AB12-CD34");
    expect(safe).not.toContain("eyJsecret");
    expect(safe).not.toContain("abc.def.ghi");
  });
});
