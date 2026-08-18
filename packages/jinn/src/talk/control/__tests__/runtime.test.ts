import { describe, expect, it, vi } from "vitest";
import { buildTalkControlManifest } from "../manifest.js";
import { TalkControlRuntime } from "../runtime.js";

function call(overrides: Record<string, unknown> = {}) {
  return {
    talkSessionId: "talk-1",
    providerCallId: "call-1",
    providerItemId: "item-1",
    tool: "talk_comment_todo",
    arguments: JSON.stringify({ id: "ABC-1", body: "On it." }),
    caller: { kind: "operator" as const },
    ...overrides,
  };
}

describe("TalkControlRuntime", () => {
  it("makes concurrent provider replays await one verified receipt", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await held;
      return { data: { commentId: "wic_1" }, uiEffect: { invalidate: ["todo:ABC-1"] } };
    });
    const verify = vi.fn(async () => ({ ok: true, evidence: { commentId: "wic_1" } }));
    const runtime = new TalkControlRuntime({ manifest: buildTalkControlManifest(), execute, verify });

    const first = runtime.dispatch(call());
    const replay = runtime.dispatch(call());
    release();

    const [a, b] = await Promise.all([first, replay]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ ok: true, verified: true, replayed: false });
    expect(b).toEqual({ ...a, replayed: true });
  });

  it("rejects a reused provider id with different arguments", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: {}, uiEffect: null }),
      verify: async () => ({ ok: true, evidence: {} }),
    });
    expect((await runtime.dispatch(call())).ok).toBe(true);
    await expect(runtime.dispatch(call({ arguments: JSON.stringify({ id: "ABC-1", body: "Different" }) })))
      .resolves.toMatchObject({ ok: false, code: "provider-call-conflict" });
  });

  it("fails non-operator and browser-target calls closed before execution", async () => {
    const execute = vi.fn(async () => ({ data: {}, uiEffect: null }));
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute,
      verify: async () => ({ ok: true, evidence: {} }),
    });

    await expect(runtime.dispatch(call({ caller: { kind: "session", callerId: "employee-session" } })))
      .resolves.toMatchObject({ ok: false, code: "operator-required" });
    await expect(runtime.dispatch(call({ providerCallId: "call-2", tool: "open_todo" })))
      .resolves.toMatchObject({ ok: false, code: "wrong-target" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never reports a mutation as successful when verification fails", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: { commentId: "wic_1" }, uiEffect: null }),
      verify: async () => ({ ok: false, evidence: {} }),
    });

    await expect(runtime.dispatch(call())).resolves.toMatchObject({ ok: false, code: "verification-failed" });
  });

  it("rejects missing, unknown, and wrongly typed arguments before execution", async () => {
    const execute = vi.fn(async () => ({ data: {}, uiEffect: null }));
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute,
      verify: async () => ({ ok: true, evidence: {} }),
    });
    await expect(runtime.dispatch(call({ arguments: JSON.stringify({ id: "ABC-1" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    await expect(runtime.dispatch(call({ providerCallId: "call-2", arguments: JSON.stringify({ id: "ABC-1", body: "ok", secret: "no" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    await expect(runtime.dispatch(call({ providerCallId: "call-3", tool: "talk_edit_todo", arguments: JSON.stringify({ id: "ABC-1", expectedVersion: "1", title: "x" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    expect(execute).not.toHaveBeenCalled();
  });
});
