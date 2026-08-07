import { describe, expect, it } from "vitest";
import type { RealtimeUsage } from "../../../shared/types.js";
import { isPricingKnown, priceTurn } from "../pricing.js";

function usage(over: Partial<RealtimeUsage> = {}): RealtimeUsage {
  return {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputTokens: 0,
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

  it("bills cached input at the cached rate, not the full one", () => {
    const cached = priceTurn("gpt-realtime-2.1", usage({ cachedInputTokens: 1_000_000 }));
    const fresh = priceTurn("gpt-realtime-2.1", usage({ inputAudioTokens: 1_000_000 }));
    expect(cached.costUsd).toBeCloseTo(0.4, 6);
    expect(cached.costUsd).toBeLessThan(fresh.costUsd);
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
