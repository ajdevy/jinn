import { describe, expect, it } from "vitest";
import { buildTalkControlManifest } from "../manifest.js";

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
      "talk_send_to_session",
      "talk_start_workflow_run",
      "read_workflow_runs",
    ]) {
      expect(byName.get(name), name).toMatchObject({ target: "gateway" });
    }
    expect(byName.get("open_todo")).toMatchObject({ target: "browser", mutability: "effect" });
    expect(byName.get("capture_current_view")).toMatchObject({ target: "browser", mutability: "read" });
  });

  it("contains no credentials, capabilities, or machine paths", () => {
    const serialized = JSON.stringify(buildTalkControlManifest());
    expect(serialized).not.toMatch(/authorization|bearer|capability|api[_-]?key|\/Users\//i);
  });
});
