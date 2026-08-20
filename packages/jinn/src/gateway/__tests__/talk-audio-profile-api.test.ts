import { beforeEach, describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";

let config: JinnConfig;
let minting: ReturnType<typeof stubMintingFetch>;

beforeEach(() => {
  config = baseConfig();
  minting = stubMintingFetch();
});

describe("Talk audio profiles", () => {
  it("mints the driving default and returns its effective VAD", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions");
    const sent = minting.calls[0]!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(sent.session.audio.input).toMatchObject({
      noise_reduction: { type: "far_field" },
      turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: false },
    });
    expect(opened.body).toMatchObject({ vadType: "semantic_vad", noiseReduction: "far_field" });
  });

  it("accepts a close-mic override for open and reissue", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions", { noiseReduction: "near_field" });
    const first = minting.calls[0]!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(first.session.audio.input.noise_reduction).toEqual({ type: "near_field" });

    await call(config, "POST", `/api/talk/sessions/${opened.body.id as string}/park`);
    const resumed = await call(config, "POST", `/api/talk/sessions/${opened.body.id as string}/resume`, {
      noiseReduction: "near_field",
    });
    const second = minting.calls.at(-1)!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(second.session.audio.input.noise_reduction).toEqual({ type: "near_field" });
    expect(resumed.body).toMatchObject({ vadType: "semantic_vad", noiseReduction: "near_field" });
  });

  it("rejects an unknown microphone profile before minting", async () => {
    const response = await call(config, "POST", "/api/talk/sessions", { noiseReduction: "studio" });
    expect(response.status).toBe(400);
    expect(minting.calls).toHaveLength(0);
  });
});
