/**
 * Carrying an engine session from one workflow attempt to the next.
 *
 * Every attempt gets its own Jinn session row — the workflow bookkeeping is
 * keyed on that one-to-one mapping — and a fresh row resumes nothing, so a
 * rework round re-derives all the context its predecessor already holds.
 * Seeding the new row with the previous attempt's engine session ref before its
 * first turn makes the ordinary resume path in `preflightTurn` fire instead.
 */

import type { Session, WorkflowAttemptContinuation } from "../shared/types.js";
import { copyCodexRollout, findCodexRollout } from "../engines/codex-rollout.js";
import { logger } from "../shared/logger.js";
import { getEngineSessionRef, getSession, recordEngineSessionId } from "./registry.js";

/**
 * The engine thread `sessionId` still holds and a new session could pick up, or
 * null. Null covers every reason a candidate is unusable: the session is gone,
 * it ran on a different engine, it never recorded a thread, or — for codex —
 * its rollout has been swept and there is nothing left to copy forward.
 */
export function resumableEngineSession(sessionId: string, engine: string): string | null {
  const session = getSession(sessionId);
  if (!session || session.engine !== engine) return null;
  const engineSessionId = getEngineSessionRef(session, engine).id;
  if (!engineSessionId) return null;
  if (engine === "codex" && !findCodexRollout(sessionId, engineSessionId)) return null;
  return engineSessionId;
}

/** Whether the target session can now see the codex thread. Any failure at all
 *  is a cold dispatch: a resume must never leave a round worse off than the cold
 *  spawn it replaced, so nothing here is allowed to escape as an error. */
function carriedCodexRollout(sessionId: string, threadId: string, sourceSessionId: string): boolean {
  try {
    if (copyCodexRollout({ threadId, fromSessionId: sourceSessionId, toSessionId: sessionId })) return true;
    logger.info(`Session ${sessionId} dispatches cold: codex thread ${threadId} has no rollout under session ${sourceSessionId}.`);
  } catch (error) {
    logger.info(`Session ${sessionId} dispatches cold: copying codex thread ${threadId} failed (${error instanceof Error ? error.message : String(error)}).`);
  }
  return false;
}

/**
 * Seed a freshly created attempt session with the engine session it continues.
 * A no-op once the session already carries a ref for that engine, so replaying
 * a dispatch after a crash never rewinds a turn that has since run.
 *
 * Failure is not fatal: the attempt dispatches cold, which is exactly what it
 * would have done before, and the reason is logged.
 */
export function continueWorkflowAttemptSession(
  session: Session,
  continueFrom: WorkflowAttemptContinuation | undefined,
): Session {
  if (!continueFrom || getEngineSessionRef(session, continueFrom.engine).id) return session;
  const { engine, engineSessionId, sourceSessionId } = continueFrom;
  if (engine === "codex" && !carriedCodexRollout(session.id, engineSessionId, sourceSessionId)) return session;
  logger.info(`Session ${session.id} continues ${engine} session ${engineSessionId} from session ${sourceSessionId}.`);
  return recordEngineSessionId(session.id, engine, engineSessionId) ?? session;
}
