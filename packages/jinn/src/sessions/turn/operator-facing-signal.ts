/**
 * Whether a reply text carries an explicit question, decision ask, or blocker
 * that the operator personally needs to see. A turn that trips this must reach
 * the primary connector target even when its trigger was a routine
 * child-session notification (see gateway/web-turn-surface.ts) — a routine
 * status reply and an operator-facing decision are not the same turn just
 * because they both originated from a notification callback.
 *
 * Not intended to be exhaustive: false negatives (a real question phrased
 * without any of these markers) fall back to the log channel, which is a
 * bounded, documented cost — not a correctness requirement this file owes.
 * Structure mirrors sessions/stop-nudge.ts::PARENT_WAIT_SIGNAL (a similarly
 * shaped "does this ask the parent something" classifier for a different
 * question), but is kept independent rather than imported: the two
 * classifiers are allowed to diverge without coupling their callers.
 */
const OPERATOR_FACING_SIGNAL =
  /\?|\b(need (?:your|the parent's) input|please confirm|which (?:option|approach)|should i|would you|let me know|blocked (?:on|by)|waiting on|awaiting (?:approval|confirmation|input)|waiting for (?:approval|confirmation|input|you|the parent)|(?:need|missing|without|awaiting) (?:the )?(?:credentials?|access|permissions?|api key|token|secret)|decision needed|needs? (?:a |an )?decision)\b/i;

export function hasOperatorFacingSignal(text: string): boolean {
  return OPERATOR_FACING_SIGNAL.test(text);
}
