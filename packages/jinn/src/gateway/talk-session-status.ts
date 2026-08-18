import { getSessionSpend } from "../sessions/registry.js";
import type { TalkControlManifest } from "../talk/control/types.js";
import { TALK_CONTEXT_BUDGET_TOKENS, contextTokens, estimateTokens } from "../talk/session/context.js";
import { isPricingKnown } from "../talk/session/pricing.js";
import { estimateToolTokens, toolsByName } from "../talk/session/tools.js";
import type { TalkSession } from "../talk/session/types.js";

/** The session as the client sees it. Credentials only leave the minting call. */
export function talkSessionStatus(session: TalkSession, manifest: TalkControlManifest) {
  return {
    id: session.id,
    browserInstanceId: session.browserInstanceId,
    credentialGeneration: session.credentialGeneration,
    sessionId: session.sessionId,
    state: session.state,
    model: session.model,
    openedAt: session.openedAt,
    lastSeenAt: session.lastSeenAt,
    turns: session.turns,
    truncatedTurns: session.truncatedTurns,
    actions: session.actions,
    brief: session.brief,
    // The brief rides replaced instructions, outside the rolling turn budget.
    briefChars: session.brief.length,
    briefTokens: estimateTokens(session.brief),
    contextTokens: contextTokens(session.turns),
    contextBudgetTokens: TALK_CONTEXT_BUDGET_TOKENS,
    exposedTools: session.exposedTools,
    toolTokens: estimateToolTokens(toolsByName(session.exposedTools)),
    spendUsd: getSessionSpend([session.sessionId]),
    pricingKnown: isPricingKnown(session.model),
    manifest,
  };
}
