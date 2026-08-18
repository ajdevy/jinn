import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildTalkControlManifest,
  renderTalkCompanyCoverageMarkdown,
  TALK_COMPANY_CAPABILITY_COVERAGE,
  validateTalkCompanyCoverage,
} from "../manifest.js";

describe("the authoritative Talk control manifest", () => {
  it("owns every provider declaration exactly once", () => {
    const manifest = buildTalkControlManifest();
    const names = manifest.operations.map((operation) => operation.name);

    expect(new Set(names).size).toBe(names.length);
    expect(manifest.version).toBe(1);
    expect(manifest.operations.every((operation) => operation.parameters.additionalProperties === false)).toBe(true);
  });

  it("routes the representative company journey through the gateway", () => {
    const byName = new Map(buildTalkControlManifest().operations.map((operation) => [operation.name, operation]));
    for (const name of [
      "read_todo",
      "talk_edit_todo",
      "talk_comment_todo",
      "talk_assign_todo",
      "talk_delegate_todo",
      "read_session",
      "talk_start_workflow_run",
      "read_workflow_runs",
    ]) {
      expect(byName.get(name), name).toMatchObject({ target: "gateway" });
    }
    expect(byName.get("open_todo")).toMatchObject({ target: "browser", mutability: "effect" });
    expect(byName.get("capture_current_view")).toMatchObject({ target: "browser", mutability: "read" });
    expect(byName.get("talk_search_chat_messages")).toMatchObject({
      target: "browser",
      mutability: "read",
      operatorOnly: false,
      parameters: {
        required: ["query"],
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
    });
    expect(byName.get("read_talk_capability")).toMatchObject({ target: "gateway", mutability: "read", operatorOnly: false });
  });

  it("keeps visible-composer actions browser-local while named-session send stays gated", () => {
    const byName = new Map(buildTalkControlManifest().operations.map((operation) => [operation.name, operation]));
    for (const name of ["talk_draft_reply", "talk_replace_draft", "talk_send_draft", "talk_draft_and_send"]) {
      const operation = byName.get(name);
      expect(operation, name).toMatchObject({
        target: "browser",
        intent: "sessions",
        mutability: "effect",
        operatorOnly: false,
      });
      expect(operation?.parameters.properties).not.toHaveProperty("id");
      expect(operation?.parameters.properties).not.toHaveProperty("sessionId");
    }
    expect(byName.get("talk_send_to_session")).toMatchObject({
      target: "browser",
      exposure: "always",
      mutability: "effect",
      operatorOnly: false,
      verification: "browser-receipt",
    });
  });

  it("contains no credentials or machine paths", () => {
    const serialized = JSON.stringify(buildTalkControlManifest());
    expect(serialized).not.toMatch(/authorization|bearer|api[_-]?key|\/Users\//i);
  });

  it("declares every company lane as executable or an explicit planned gap", () => {
    expect(validateTalkCompanyCoverage()).toEqual([]);
    expect(Object.values(TALK_COMPANY_CAPABILITY_COVERAGE).every((entry) => entry.status === "supported"
      || Boolean(entry.reason && entry.plannedAdapter))).toBe(true);
  });

  it("keeps the company section of the operator coverage report fresh", () => {
    const report = readFileSync("../../docs/talk-control-coverage.md", "utf8");
    expect(report).toContain(renderTalkCompanyCoverageMarkdown());
  });
});
