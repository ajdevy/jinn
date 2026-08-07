/**
 * Pins how the OpenAI realtime adapter opens and closes a session: the `session`
 * payload it builds, the handshake it holds open until the server acknowledges
 * that payload, and the guards against connecting or sending out of order.
 *
 * Server-event translation is pinned separately in openai-server-events.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports below, so the fake has to be pulled in
// from inside the factory instead of through this file's import bindings.
vi.mock("ws", async () => ({ default: (await import("./helpers/fake-realtime-socket.js")).FakeSocket }));

const { connected, lastSocket, realtimeAdapter, receive, resetSocket, sentTypes, settled } = await import(
  "./helpers/fake-realtime-socket.js"
);
const { createOpenAiRealtimeProvider, buildSessionPayload } = await realtimeAdapter();

beforeEach(() => {
  resetSocket();
});

describe("buildSessionPayload", () => {
  it("asks for server VAD with barge-in by default", () => {
    const payload = buildSessionPayload({}) as { audio: { input: { turn_detection: Record<string, unknown> } } };
    expect(payload.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
    });
  });

  it("disables turn detection for push-to-talk", () => {
    const payload = buildSessionPayload({ turnDetection: "none" }) as { audio: { input: { turn_detection: unknown } } };
    expect(payload.audio.input.turn_detection).toBeNull();
  });

  it("omits the voice rather than sending an empty one", () => {
    expect(buildSessionPayload({})).not.toHaveProperty("audio.output.voice");
    const withVoice = buildSessionPayload({ voice: "marin" }) as { audio: { output: { voice: string } } };
    expect(withVoice.audio.output.voice).toBe("marin");
  });

  it("declares tools in the shape the API expects", () => {
    const payload = buildSessionPayload({
      tools: [{ name: "list_todos", description: "List open todos", parameters: { type: "object" } }],
    }) as { tools: Record<string, unknown>[] };
    expect(payload.tools).toEqual([
      { type: "function", name: "list_todos", description: "List open todos", parameters: { type: "object" } },
    ]);
  });
});

describe("OpenAI realtime session lifecycle", () => {
  it("rejects construction without an API key", () => {
    expect(() => createOpenAiRealtimeProvider({ apiKey: "" })).toThrow(/requires an API key/);
  });

  it("configures the session on connect and names the model in the URL", async () => {
    await connected({ model: "gpt-realtime-2.1" });

    expect(lastSocket().url).toContain("model=gpt-realtime-2.1");
    expect(sentTypes()).toEqual(["session.update"]);
  });

  it("stays pending until the server acknowledges the session", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect({ turnDetection: "none" });

    lastSocket().emit("open");
    expect(sentTypes()).toEqual(["session.update"]);
    // An open socket is not a configured session: audio sent now would be
    // handled under the default server-VAD session, not this one.
    expect(await settled(connecting)).toBe(false);

    receive({ type: "session.updated" });
    expect(await settled(connecting)).toBe(true);
    await expect(connecting).resolves.toBeUndefined();
  });

  it("rejects the connect when the server refuses the session config", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect();

    lastSocket().emit("open");
    receive({ type: "error", error: { message: "unknown voice" } });

    await expect(connecting).rejects.toThrow(/unknown voice/);
  });

  it("rejects the connect when the socket closes before the acknowledgement", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect();

    lastSocket().emit("open");
    lastSocket().close();

    await expect(connecting).rejects.toThrow(/closed before the session was configured/);
  });

  it("refuses a second connect on the same provider", async () => {
    const { provider } = await connected();
    expect(() => provider.connect()).toThrow(/already connected/);
  });

  it("refuses to send before connecting", () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    expect(() => provider.sendAudio(Buffer.from([0, 1]))).toThrow(/not connected/);
  });

  it("reports the close and drops the socket", async () => {
    const { provider, events } = await connected();

    provider.disconnect();

    expect(events).toEqual([{ type: "closed", reason: "code 1000" }]);
    expect(() => provider.sendAudio(Buffer.from([0]))).toThrow(/not connected/);
  });

  it("tolerates disconnecting a provider that never connected", () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    expect(() => provider.disconnect()).not.toThrow();
  });
});
