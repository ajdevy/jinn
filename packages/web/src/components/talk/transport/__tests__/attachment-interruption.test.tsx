import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectOptions, ConnectRealtime } from "../webrtc-connection";

const authFetch = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) };
});

const { useAttach } = await import("../attachment");
const { browserControlFixture } = await import("./control-fixture");

const event = (type: string, fields: Record<string, unknown> = {}) => JSON.stringify({ type, ...fields });

function interruptionRequests() {
  return authFetch.mock.calls.filter(([url]) => String(url).endsWith("/interruptions"));
}

function capturedProvider(value: ConnectOptions | null): ConnectOptions {
  if (!value) throw new Error("The attachment did not connect to the provider.");
  return value;
}

describe("production Talk attachment interruption telemetry", () => {
  beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  it("posts exactly the five content-free fields emitted by the live driver", async () => {
    let provider: ConnectOptions | null = null;
    const connect: ConnectRealtime = async (options) => {
      provider = options;
      options.onOpen();
      return { send: () => {}, close: () => {} };
    };
    const level = { current: 0 };
    const attached = renderHook(() => useAttach(connect, level, () => {}, () => {}));

    await act(async () => {
      await attached.result.current("talk-1", "token-1", "brief", browserControlFixture(), {
        browserInstanceId: "browser-1",
        credentialGeneration: 1,
        vadType: "semantic_vad",
      });
    });
    const frame = capturedProvider(provider).onFrame;
    const privateCanary = "private-utterance-must-not-enter-interruption-telemetry";
    frame(event("response.created", { response: { id: "response-1" } }));
    frame(event("input_audio_buffer.speech_started", { item_id: "item-1", audio_start_ms: 1_000 }));
    frame(event("response.done", {
      response: { id: "response-1", status: "cancelled", status_details: { reason: "turn_detected" } },
    }));
    frame(event("output_audio_buffer.cleared", { response_id: "response-1" }));
    frame(event("input_audio_buffer.speech_stopped", { item_id: "item-1", audio_end_ms: 1_240 }));
    frame(event("conversation.item.input_audio_transcription.completed", {
      item_id: "item-1",
      event_id: "event-item-1",
      transcript: privateCanary,
    }));

    await waitFor(() => expect(interruptionRequests()).toHaveLength(1));
    const [, init] = interruptionRequests()[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["cancelledBy", "kind", "recovered", "speechMs", "vadType"]);
    expect(body).toEqual({
      kind: "speech_interruption",
      vadType: "semantic_vad",
      cancelledBy: "provider",
      recovered: false,
      speechMs: 240,
    });
    expect(JSON.stringify(body)).not.toContain(privateCanary);
  });
});
