/**
 * Turn a provider's reported token counts into dollars.
 *
 * Rates come from docs/realtime-providers.md, which quotes the vendor pricing
 * pages verbatim (checked 2026-08-06).
 */
import type { RealtimeUsage } from "../../shared/types.js";

/** USD per 1M tokens. */
interface RealtimeRate {
  inputAudio: number;
  cachedInput: number;
  outputAudio: number;
  inputText: number;
  outputText: number;
}

/**
 * Keyed by the versioned model ids the pricing page actually lists. The
 * unversioned `gpt-realtime` alias is deliberately absent: it resolves to
 * whichever version OpenAI currently points it at, so pricing it here would be
 * a guess that reads like a fact. A session on it reports `pricingKnown: false`
 * and the operator pins a versioned id in `realtime.model` to get real numbers.
 */
const RATES: Record<string, RealtimeRate> = {
  "gpt-realtime-2.1": { inputAudio: 32, cachedInput: 0.4, outputAudio: 64, inputText: 4, outputText: 24 },
  "gpt-realtime-2.1-mini": { inputAudio: 10, cachedInput: 0.3, outputAudio: 20, inputText: 0.6, outputText: 2.4 },
};

/** Stands in for the model when `realtime.model` is unset: the provider picks,
 *  so the gateway cannot name the model and therefore cannot price it. */
export const UNPINNED_MODEL = "provider-default";

export interface TurnPrice {
  costUsd: number;
  /** False when the model is absent from the rate table. The caller surfaces the
   *  flag rather than a $0.00 that reads like a free turn. */
  pricingKnown: boolean;
}

const PER_MILLION = 1_000_000;

/** Price one turn's usage. `usage` is the delta for that turn, not a
 *  session-to-date total — the caller subtracts before it gets here. */
export function priceTurn(model: string, usage: RealtimeUsage): TurnPrice {
  const rate = RATES[model];
  if (!rate) return { costUsd: 0, pricingKnown: false };
  // Cached tokens are a subset of the input counts, not a bucket alongside them:
  // billing both charges the cached prefix twice. Deduct audio first, because a
  // voice turn's cached prefix is the conversation audio being re-sent.
  const cachedAudioTokens = Math.min(usage.inputAudioTokens, usage.cachedInputTokens);
  const cachedTextTokens = Math.min(usage.inputTextTokens, usage.cachedInputTokens - cachedAudioTokens);
  const costUsd =
    ((usage.inputAudioTokens - cachedAudioTokens) * rate.inputAudio +
      (usage.inputTextTokens - cachedTextTokens) * rate.inputText +
      usage.cachedInputTokens * rate.cachedInput +
      usage.outputAudioTokens * rate.outputAudio +
      usage.outputTextTokens * rate.outputText) /
    PER_MILLION;
  return { costUsd, pricingKnown: true };
}

/** Whether this session's model can be priced at all, for the status response. */
export function isPricingKnown(model: string): boolean {
  return model in RATES;
}
