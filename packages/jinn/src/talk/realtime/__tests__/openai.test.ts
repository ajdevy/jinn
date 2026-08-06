import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent, RealtimeProvider } from "../../../shared/types.js";

/** Stands in for a `ws` socket so the adapter's protocol translation can be
 *  driven with the exact frames the live Realtime API emits. Hand-rolled rather
 *  than an EventEmitter subclass: `vi.hoisted` runs before the imports. */
const socketModule = vi.hoisted(() => {
  type Listener = (...args: never[]) => void;

  class FakeSocket {
    static last: FakeSocket | undefined;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly url: string) {
      FakeSocket.last = this;
    }

    on(event: string, listener: Listener): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }

    once(event: string, listener: Listener): void {
      const wrapped = (...args: never[]): void => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped));
        listener(...args);
      };
      this.on(event, wrapped);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...(args as never[]));
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.emit("close", 1000, Buffer.from(""));
    }
  }
  return { FakeSocket };
});

vi.mock("ws", () => ({ default: socketModule.FakeSocket }));

const { createOpenAiRealtimeProvider, buildSessionPayload } = await import("../openai.js");

const { FakeSocket } = socketModule;

function lastSocket(): InstanceType<typeof FakeSocket> {
  const socket = FakeSocket.last;
  if (!socket) throw new Error("the adapter never opened a socket");
  return socket;
}

function receive(message: unknown): void {
  lastSocket().emit("message", Buffer.from(JSON.stringify(message)));
}

/** Connect a provider against the fake transport and collect everything it emits. */
async function connected(options = {}): Promise<{ provider: RealtimeProvider; events: RealtimeEvent[] }> {
  const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
  const events: RealtimeEvent[] = [];
  provider.on((event) => events.push(event));
  const connecting = provider.connect(options);
  lastSocket().emit("open");
  receive({ type: "session.updated" });
  await connecting;
  return { provider, events };
}

/** True once `promise` has settled, without leaving it unhandled either way.
 *  The marker is a timer rather than a resolved promise so every pending
 *  microtask drains first, otherwise a just-settled promise still reads pending. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const marker = new Promise((resolve) => setTimeout(() => resolve(pending), 0));
  return (await Promise.race([promise.catch(() => undefined), marker])) !== pending;
}

function sentTypes(): string[] {
  return lastSocket().sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

beforeEach(() => {
  FakeSocket.last = undefined;
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

describe("OpenAI realtime adapter", () => {
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

  it("decodes assistant audio deltas to raw PCM", async () => {
    const { events } = await connected();
    const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    receive({ type: "response.output_audio.delta", delta: pcm.toString("base64") });

    expect(events).toEqual([{ type: "audio", audio: pcm }]);
  });

  it("reports VAD speech boundaries", async () => {
    const { events } = await connected();

    receive({ type: "input_audio_buffer.speech_started" });
    receive({ type: "input_audio_buffer.speech_stopped" });

    expect(events).toEqual([{ type: "speech_started" }, { type: "speech_stopped" }]);
  });

  it("separates streaming and final transcripts by role", async () => {
    const { events } = await connected();

    receive({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    receive({ type: "response.output_audio_transcript.done", transcript: "Hello." });
    receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi there." });

    expect(events).toEqual([
      { type: "transcript", role: "assistant", text: "Hel", final: false },
      { type: "transcript", role: "assistant", text: "Hello.", final: true },
      { type: "transcript", role: "user", text: "Hi there.", final: true },
    ]);
  });

  it("surfaces tool calls with the id needed to answer them", async () => {
    const { provider, events } = await connected();

    receive({
      type: "response.function_call_arguments.done",
      call_id: "call_42",
      name: "list_todos",
      arguments: '{"status":"open"}',
    });
    provider.sendToolResult("call_42", '{"count":3}');

    expect(events).toEqual([
      { type: "tool_call", callId: "call_42", name: "list_todos", arguments: '{"status":"open"}' },
    ]);
    const item = JSON.parse(lastSocket().sent[1]) as { item: Record<string, unknown> };
    expect(item.item).toEqual({ type: "function_call_output", call_id: "call_42", output: '{"count":3}' });
    expect(sentTypes()).toEqual(["session.update", "conversation.item.create", "response.create"]);
  });

  it("commits a push-to-talk turn and asks for a response", async () => {
    const { provider } = await connected({ turnDetection: "none" });

    provider.sendAudio(Buffer.from([0x10, 0x20]));
    provider.commitAudio();

    expect(sentTypes()).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "response.create",
    ]);
  });

  it("accumulates usage across turns", async () => {
    const { provider, events } = await connected();
    const usage = {
      input_token_details: { text_tokens: 5, audio_tokens: 100, cached_tokens: 2 },
      output_token_details: { text_tokens: 9, audio_tokens: 17 },
    };

    receive({ type: "response.done", response: { status: "completed", usage } });
    receive({ type: "response.done", response: { status: "completed", usage } });

    expect(provider.usage()).toEqual({
      inputAudioTokens: 200,
      inputTextTokens: 10,
      cachedInputTokens: 4,
      outputAudioTokens: 34,
      outputTextTokens: 18,
    });
    expect(events.at(-1)).toEqual({ type: "turn_done", usage: provider.usage() });
  });

  it("attributes an unrequested cancellation to barge-in", async () => {
    const { events } = await connected();

    receive({ type: "response.done", response: { status: "cancelled" } });

    expect(events).toEqual([{ type: "response_cancelled", reason: "barge_in" }]);
  });

  it("attributes a cancellation we asked for to the client, once", async () => {
    const { provider, events } = await connected();

    provider.interrupt();
    receive({ type: "response.done", response: { status: "cancelled" } });
    receive({ type: "response.done", response: { status: "cancelled" } });

    expect(sentTypes()).toContain("response.cancel");
    expect(events).toEqual([
      { type: "response_cancelled", reason: "client" },
      { type: "response_cancelled", reason: "barge_in" },
    ]);
  });

  it("passes through API errors and malformed frames", async () => {
    const { events } = await connected();

    receive({ type: "error", error: { message: "session expired" } });
    lastSocket().emit("message", Buffer.from("not json"));

    expect(events).toEqual([
      { type: "error", message: "session expired" },
      { type: "error", message: "OpenAI realtime sent a frame that is not JSON" },
    ]);
  });

  it("ignores the item-lifecycle events it has no equivalent for", async () => {
    const { events } = await connected();

    receive({ type: "session.created" });
    receive({ type: "response.content_part.added" });
    receive({ type: "conversation.item.done" });

    expect(events).toEqual([]);
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
