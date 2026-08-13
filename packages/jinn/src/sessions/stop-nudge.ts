/**
 * A turn that ends on narration has decided nothing: nothing submitted, no
 * terminal claim, no block reported. Both surfaces that own tracked work — the
 * workflow attempt and the delegated child — answer it the same way, with a
 * bounded, counted nudge sent at that turn's own end. Each nudge is itself a
 * turn, so the count is what closes the loop; after MAX_STOP_NUDGES the caller
 * falls back to whatever it did before.
 *
 * The classifier keeps the delegation contract's fail-safe bias, because that
 * is where it came from: it fires only on an explicit first-person continuation
 * or task-incomplete assertion. Ambiguity, a terminal claim, and a question
 * back to the parent all mean no nudge. Missed nudges are acceptable; a nudge
 * sent to a session that already finished is the harm this bias prevents.
 */

/** Two, so a model that narrates twice still gets one more chance to submit
 *  before the surface stops talking and lets its own timeout logic run. */
export const MAX_STOP_NUDGES = 2;

export const STOP_NUDGE_TEXT =
  "A plain-text reply is not a terminal state. Your linked Todo is still open and this turn ended on narration "
  + "rather than on a result. Continue the work now and finish the deliverable, then submit it the way this task "
  + "requires. If you cannot finish it, say plainly that you are blocked and what is blocking you. Do not end "
  + "another turn on a promise of future action.";

const EXPLICIT_UNFINISHED_SIGNAL = /\b(?:i(?: am|['’]m) still working (?:on|through)|i(?: will|['’]ll) continue (?:working\b|(?:with\s+)?(?:this|the|my)\s+(?:task|work|implementation|fix|patch|change|migration|feature|deliverable|test run)|with (?:the )?remaining (?:work|implementation|checks|tests?))|(?:(?:the|this|my)\s+)?(?:task|work|implementation|fix|patch|change|migration|feature|deliverable)\s+(?:is|remains)\s+(?:incomplete|still in progress)|not (?:done|finished|complete))\b/i;
const TERMINAL_SIGNAL = /\b(final report|completed|complete|done|finished|shipped|implemented|resolved|all tests pass(?:ed)?|(?:tests?|checks?) (?:now )?pass(?:ed)?|ready for review|ready to merge|(?:the )?(?:pr|patch) (?:is )?ready|commit (?:sha|hash)|hand(?:-| )?off)\b/i;
const PARENT_WAIT_SIGNAL = /\?|\b(need (?:your|the parent's) input|please confirm|which (?:option|approach)|should i|would you|let me know|blocked (?:on|by)|waiting on|awaiting (?:approval|confirmation|input)|waiting for (?:approval|confirmation|input|you|the parent)|(?:need|missing|without|awaiting) (?:the )?(?:credentials?|access|permissions?|api key|token|secret))\b/i;

/** Whether this final text is a progress note and nothing more. */
export function isNonTerminalNarration(text: string): boolean {
  const terminalCandidate = text.replace(/\bnot\s+(?:done|finished|complete)\b/gi, " ");
  // Incidental mentions of work, running services, remaining items, or next
  // steps are not evidence that the task remains unfinished. The nudge requires
  // a first-person continuation assertion, a task-bound incomplete/still-in-progress
  // assertion, or explicit negated completion.
  const hasExplicitUnfinished = EXPLICIT_UNFINISHED_SIGNAL.test(text);
  const hasTerminal = TERMINAL_SIGNAL.test(terminalCandidate);
  // Mixed terminal + unfinished clauses are ambiguous. Under the fail-safe
  // contract, ambiguity surfaces to the caller; it never authorizes a nudge.
  if (hasTerminal && hasExplicitUnfinished) return false;
  return hasExplicitUnfinished && !hasTerminal && !PARENT_WAIT_SIGNAL.test(text);
}

/** Whether this turn end earns a stop nudge, given how many it has already had. */
export function planStopNudge(input: { finalText: string; stopNudgesSent: number }): boolean {
  return input.stopNudgesSent < MAX_STOP_NUDGES && isNonTerminalNarration(input.finalText.trim());
}
