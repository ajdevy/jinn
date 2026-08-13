import { isRateLimitMessage } from '../shared/rateLimit.js';
import { commentsTail } from './comments.js';
import { listWorkItemEvents } from './event-log.js';
import { parseTodoId } from './id.js';
import { listWorkItemRuns, type TodoRun } from './runs.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Pre-claim respawn guards (ICI-731).
 *
 * An automated re-dispatch — a workflow re-arm, a status-driven trigger, any
 * future auto-pickup — asks these four predicates before it takes the Todo's
 * claim. Each answers the same question from a different fact: would another
 * attempt right now actually help? Jinn has had repeat-worker storms, and every
 * one of them was a re-dispatch a cheap read could have refused.
 *
 * A hold is audited and takes NO claim, so a Todo the guards parked is still
 * free for a human to dispatch by hand. Human-initiated pickup never comes
 * through here at all: the operator pressing Dispatch, and `delegate_task`, are
 * somebody deciding to do this work, which is exactly the input these guards
 * are waiting for.
 */

export type RespawnGuard = 'rate_limit_cooldown' | 'blocker_auth' | 'recent_success' | 'active_pr';

export interface RespawnGuardHold {
  state: 'held';
  guard: RespawnGuard;
  reason: string;
}

export type RespawnGuardVerdict = { state: 'allowed' } | RespawnGuardHold;

/** How long a quota window parks automated re-dispatch. The same grace the
 *  engine backoff already gives a rate-limited attempt. */
export const RESPAWN_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/** What "recent" means to `recent_success` and `active_pr`. Longer would park
 *  legitimate retries; shorter would not outlast a storm. */
export const RESPAWN_RECENT_WINDOW_MS = 60 * 60_000;

/** The comment tail the two comment-reading guards scan. Both only care about
 *  the last hour, and no Todo writes more than this many comments in one. */
const COMMENT_SCAN = 50;

/** The actor a human's own writes carry. An employee is not a human here: the
 *  point of `recent_success` is that somebody outside the loop has looked. */
const HUMAN_ACTOR = 'operator';

/** Errors no retry can fix, because the credentials themselves are the problem. */
const AUTH_ERROR_RE =
  /unauthori[sz]|unauthenticated|forbidden|\b401\b|\b403\b|invalid[ _-]?(api[ _-]?)?key|invalid[ _-]?token|expired[ _-]?(token|credential|session)|credential|authenticat|not logged in|please log in|oauth/i;

/** A pull request a previous attempt already opened. */
const PR_URL_RE = /https?:\/\/[^\s)]+\/(?:pull|merge_requests)\/\d+/i;

/** A run that reached an outcome, so its `endedAt` is a fact rather than a maybe. */
type SettledRun = TodoRun & { endedAt: string };

/**
 * Whether an automated re-dispatch of this Todo should proceed.
 *
 * `rate_limit_cooldown` is evaluated FIRST and that ordering is load-bearing:
 * quota vocabulary ("usage limit", "exceeded limit") sits inside error text wide
 * enough for the auth matcher to claim, and losing that race parks the Todo
 * behind a guard only a human can clear — while the quota window clears itself.
 */
export function checkRespawnGuard(workItemId: string, now: Date = new Date()): RespawnGuardVerdict {
  const id = parseTodoId(workItemId);
  const lastSettled = lastSettledRun(listWorkItemRuns(id));
  return rateLimitCooldown(lastSettled, now)
    ?? blockerAuth(lastSettled)
    ?? recentSuccess(id, lastSettled, now)
    ?? activePullRequest(id, now)
    ?? { state: 'allowed' };
}

/**
 * Record a hold, so a Todo that was not picked up says why rather than going
 * quiet. Audit-only: a guard is a decision about a dispatch, not a change to
 * the Todo.
 */
export function appendRespawnGuardHold(workItemId: string, hold: RespawnGuardHold, actor: string): void {
  appendWorkItemEvent({
    workItemId,
    kind: 'respawn_guard_held',
    actor,
    detail: { guard: hold.guard, reason: hold.reason },
    versionEffect: 'audit',
  });
}

function held(guard: RespawnGuard, reason: string): RespawnGuardHold {
  return { state: 'held', guard, reason };
}

function lastSettledRun(runs: TodoRun[]): SettledRun | undefined {
  return runs
    .filter((run): run is SettledRun => run.endedAt !== null)
    .reduce<SettledRun | undefined>((latest, run) => (!latest || run.endedAt > latest.endedAt ? run : latest), undefined);
}

/** A quota window is not a failure and does not need a human — it needs time. */
function rateLimitCooldown(run: SettledRun | undefined, now: Date): RespawnGuardHold | undefined {
  if (!run) return undefined;
  if (run.outcome !== 'rate_limited' && !isRateLimitMessage(run.error)) return undefined;
  const clearsAt = Date.parse(run.endedAt) + RESPAWN_RATE_LIMIT_COOLDOWN_MS;
  if (now.getTime() >= clearsAt) return undefined;
  return held('rate_limit_cooldown',
    `run ${run.id} hit a quota window at ${run.endedAt}; automated re-dispatch waits until ${new Date(clearsAt).toISOString()}`);
}

/** Retrying cannot mint credentials, so an auth-shaped failure waits for a human
 *  rather than for a clock. */
function blockerAuth(run: SettledRun | undefined): RespawnGuardHold | undefined {
  if (!run || !isFailure(run) || run.error === null || !AUTH_ERROR_RE.test(run.error)) return undefined;
  return held('blocker_auth', `run ${run.id} failed on credentials, which a retry cannot fix: ${firstLine(run.error)}`);
}

/** Work that just succeeded and that nobody has read yet does not need doing
 *  again; it needs reading. */
function recentSuccess(workItemId: string, run: SettledRun | undefined, now: Date): RespawnGuardHold | undefined {
  if (!run || run.outcome !== 'completed') return undefined;
  if (now.getTime() - Date.parse(run.endedAt) >= RESPAWN_RECENT_WINDOW_MS) return undefined;
  if (humanLookedAfter(workItemId, run.endedAt)) return undefined;
  return held('recent_success', `run ${run.id} completed at ${run.endedAt} and no human has looked at it since`);
}

/** A previous attempt already shipped something a reviewer can see; a second
 *  attempt would ship it twice. */
function activePullRequest(workItemId: string, now: Date): RespawnGuardHold | undefined {
  const since = new Date(now.getTime() - RESPAWN_RECENT_WINDOW_MS).toISOString();
  const branch = `build/${workItemId}`;
  for (const comment of commentsTail(workItemId, COMMENT_SCAN).comments) {
    if (comment.deletedAt !== null || comment.createdAt <= since) continue;
    if (PR_URL_RE.test(comment.body)) {
      return held('active_pr', `a comment at ${comment.createdAt} already carries a pull request for this Todo`);
    }
    if (comment.body.includes(branch)) {
      return held('active_pr', `a comment at ${comment.createdAt} already carries branch ${branch}`);
    }
  }
  return undefined;
}

/** A human comment or a human status move after the run ended — the look the
 *  `recent_success` hold is waiting for. */
function humanLookedAfter(workItemId: string, endedAt: string): boolean {
  const commented = commentsTail(workItemId, COMMENT_SCAN).comments.some(
    (comment) => comment.authorKind === 'operator' && comment.deletedAt === null && comment.createdAt > endedAt,
  );
  if (commented) return true;
  return listWorkItemEvents(workItemId).some(
    (event) => event.kind === 'status_change' && event.actor === HUMAN_ACTOR && event.createdAt > endedAt,
  );
}

/** A settled run that reported a problem. `rate_limited` is deliberately not one:
 *  a quota window is the cooldown guard's business, not a failure. */
function isFailure(run: SettledRun): boolean {
  return run.outcome !== 'completed' && run.outcome !== 'rate_limited';
}

/** Error text goes into an audit detail, so it is bounded before it gets there. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
