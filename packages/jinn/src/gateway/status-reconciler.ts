import type { Engine } from "../shared/types.js";
import { beginSessionAttempt, listSessions } from "../sessions/registry.js";
import { settleTurn } from "../sessions/turn/completion.js";
import type { TurnSurface } from "../sessions/turn/types.js";
import { logger } from "../shared/logger.js";

const DEFAULT_INTERVAL_MS = 15_000;
/** Every turn arms the same heartbeat (sessions/turn/heartbeat.ts), which
 *  refreshes lastActivity every 5s while the turn is in flight — connector,
 *  cron, workflow and web alike. A "running" session whose heartbeat is older
 *  than this has no live turn driving it: the completion event was lost.
 *
 *  Queued-but-not-started turns are safe: the POST handler sets
 *  status:"running" + lastActivity synchronously at enqueue, and the turn
 *  re-sets both when it actually starts (and the 5s heartbeat takes over).
 *  Worst case a long-delayed queue item gets its spinner cleared here and
 *  re-armed by session:started when the turn begins. */
const DEFAULT_STALE_MS = 45_000;

export interface StatusReconcilerDeps {
  engines: Map<string, Engine>;
  /** The transport seam a settled turn reports through — the web runner's own, so there is no second emit site. */
  surfaceFor: (sessionId: string) => TurnSurface;
  intervalMs?: number;
  staleMs?: number;
  /** Test override. */
  now?: () => number;
  /** Carry-over between sweeps: sessions seen stuck once. A session is only
   *  reset on the SECOND consecutive sweep that finds it stuck — a single
   *  observation can be the benign seconds between a turn's process exiting
   *  and the gateway persisting its final status. Created by
   *  startStatusReconciler; tests may pass their own. */
  pendingStuck?: Set<string>;
}

/** One sweep: unstick sessions stuck at status:"running" with no live turn, by
 *  settling them through the one completion path. Returns the number settled —
 *  a session whose fence was lost is not a fix. Exported for tests. */
export async function sweepOnce(deps: StatusReconcilerDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let fixed = 0;
  for (const session of listSessions({ status: "running" })) {
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    const staleFor = now - last;
    if (staleFor < staleMs) {
      deps.pendingStuck?.delete(session.id); // fresh heartbeat — recovered, clear any mark
      continue; // heartbeat is live — a turn is in flight
    }
    const engine = deps.engines.get(session.engine);
    // Same live-turn probe as the API status path: interactive engines expose
    // isTurnRunning (warm-but-idle PTYs must not count); headless engines
    // approximate with isAlive; an unknown engine cannot have a live turn.
    const turnRunning = !!engine && (
      "isTurnRunning" in engine
        ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id)
        : (typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
          ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(session.id)
          : false)
    );
    if (turnRunning) {
      deps.pendingStuck?.delete(session.id); // live turn — clear any mark
      continue;
    }
    // Session qualifies as stuck: stale heartbeat + no live turn.
    const pending = deps.pendingStuck;
    if (pending && !pending.has(session.id)) {
      pending.add(session.id);
      continue; // confirm on the next sweep — could be a turn-boundary race
    }
    pending?.delete(session.id);
    // A session set running outside an attempt carries no token; mint one so
    // the receipt still settles under a generation the fence can compare.
    const attemptToken = session.attemptToken ?? beginSessionAttempt(session.id)?.attemptToken;
    if (!attemptToken) continue;
    // notifyParent keeps its notifying default: this is the one interrupt with
    // no interrupter left to report it.
    const settled = await settleTurn({
      sessionId: session.id,
      attemptToken,
      outcome: "interrupted",
      error: "Interrupted: engine turn ended without a terminal result",
      surface: deps.surfaceFor(session.id),
    });
    if (!settled) continue; // a stop, reset or newer turn owns the attempt
    logger.warn(
      `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — marked interrupted`,
    );
    fixed++;
  }
  return fixed;
}

/** Start the periodic sweep. Returns a stop function. */
export function startStatusReconciler(deps: StatusReconcilerDeps): () => void {
  const pendingStuck = deps.pendingStuck ?? new Set<string>();
  let sweeping = false; // the two-sweep confirmation only means anything across interval-separated ticks
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepOnce({ ...deps, pendingStuck })
      .catch((err) => logger.warn(`[reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { sweeping = false; });
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
