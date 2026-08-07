import { describe, expect, it } from "vitest";
import type { RealtimeUsage } from "../../../shared/types.js";
import { dearerCachedModality, isPricingKnown, priceTurn } from "../pricing.js";

const PRICED_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"];

function usage(over: Partial<RealtimeUsage> = {}): RealtimeUsage {
  return {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputAudioTokens: 0,
    cachedInputTextTokens: 0,
    ...over,
  };
}

describe("priceTurn", () => {
  it("prices a known model against its published per-million rates", () => {
    // 1M input audio at $32.00 plus 1M output audio at $64.00.
    const priced = priceTurn("gpt-realtime-2.1", usage({ inputAudioTokens: 1_000_000, outputAudioTokens: 1_000_000 }));
    expect(priced.pricingKnown).toBe(true);
    expect(priced.costUsd).toBeCloseTo(96, 6);
  });

  it("bills each cached modality at its own cached rate", () => {
    // On the mini model cached text is a fifth of cached audio: $0.06 against $0.30.
    const cachedText = priceTurn("gpt-realtime-2.1-mini", usage({ inputTextTokens: 1_000_000, cachedInputTextTokens: 1_000_000 }));
    const cachedAudio = priceTurn("gpt-realtime-2.1-mini", usage({ inputAudioTokens: 1_000_000, cachedInputAudioTokens: 1_000_000 }));
    expect(cachedText.costUsd).toBeCloseTo(0.06, 9);
    expect(cachedAudio.costUsd).toBeCloseTo(0.3, 9);
  });

  it("prices the mixed-modality turn the echo run actually measured", () => {
    // docs/realtime-providers.md: 58 input audio tokens and 119 input text tokens,
    // 64 of the text already cached. 58x$32 + 55x$4 + 64x$0.40, per 1M.
    const priced = priceTurn(
      "gpt-realtime-2.1",
      usage({ inputAudioTokens: 58, inputTextTokens: 119, cachedInputTextTokens: 64 }),
    );
    expect(priced.costUsd).toBeCloseTo(0.0021016, 9);
  });

  it("treats cached tokens as a subset of the input count rather than an extra charge", () => {
    // The provider reports the cached prefix inside the input counts, so a fully
    // cached turn costs the cached rate alone: 1M at $0.40, not $32.00 + $0.40.
    const allCachedAudio = priceTurn(
      "gpt-realtime-2.1",
      usage({ inputAudioTokens: 1_000_000, cachedInputAudioTokens: 1_000_000 }),
    );
    expect(allCachedAudio.costUsd).toBeCloseTo(0.4, 6);

    // Same on the text side: 1M at $0.40, not $4.00 + $0.40.
    const allCachedText = priceTurn(
      "gpt-realtime-2.1",
      usage({ inputTextTokens: 1_000_000, cachedInputTextTokens: 1_000_000 }),
    );
    expect(allCachedText.costUsd).toBeCloseTo(0.4, 6);

    // 750k fresh audio at $32.00 plus 250k cached at $0.40.
    const partlyCached = priceTurn(
      "gpt-realtime-2.1",
      usage({ inputAudioTokens: 1_000_000, cachedInputAudioTokens: 250_000 }),
    );
    expect(partlyCached.costUsd).toBeCloseTo(24.1, 6);
  });

  it("prices the mini model below the full one for identical usage", () => {
    const load = usage({ inputAudioTokens: 36_000, outputAudioTokens: 12_000 });
    expect(priceTurn("gpt-realtime-2.1-mini", load).costUsd)
      .toBeLessThan(priceTurn("gpt-realtime-2.1", load).costUsd);
  });

  it("flags an unknown model rather than reporting a free turn", () => {
    // The unversioned alias resolves to whichever version the vendor points it
    // at, so it is deliberately unpriced.
    const priced = priceTurn("gpt-realtime", usage({ inputAudioTokens: 1_000_000 }));
    expect(priced.pricingKnown).toBe(false);
    expect(priced.costUsd).toBe(0);
    expect(isPricingKnown("gpt-realtime")).toBe(false);
    expect(isPricingKnown("gpt-realtime-2.1")).toBe(true);
  });

  it("charges nothing for a turn that used nothing", () => {
    expect(priceTurn("gpt-realtime-2.1", usage()).costUsd).toBe(0);
  });
});

describe("dearerCachedModality", () => {
  it("names the modality an unattributed cached count cannot under-report", () => {
    for (const model of PRICED_MODELS) {
      const cost = {
        audio: priceTurn(model, usage({ inputAudioTokens: 1_000_000, cachedInputAudioTokens: 1_000_000 })).costUsd,
        text: priceTurn(model, usage({ inputTextTokens: 1_000_000, cachedInputTextTokens: 1_000_000 })).costUsd,
      };
      expect(cost[dearerCachedModality(model)]).toBe(Math.max(cost.audio, cost.text));
    }
  });

  it("falls back to audio for a model it cannot price", () => {
    expect(dearerCachedModality("gpt-realtime")).toBe("audio");
  });
});
