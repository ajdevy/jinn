import fs from "node:fs";
import path from "node:path";
import { resolveFallbackEngine } from "./engine-fallback.js";
import type { EngineName } from "./models.js";
import { JINN_HOME } from "./paths.js";
import type { EngineLimitWindow, JinnConfig, ModelRegistry } from "./types.js";

/**
 * Whether an engine can actually serve a turn, beside the installed-availability
 * the model registry reports.
 *
 * Advisory by construction, and every part of that is deliberate: reads and
 * writes swallow their own errors, every record carries the moment it stops
 * being true, and both dispatchers walk their chain again without health when
 * health would have left them nothing. The worst a wrong record can do is order
 * a chain differently — it can never refuse a turn.
 */

export type EngineHealthState = "ok" | "exhausted" | "degraded";

export interface EngineHealth {
  state: EngineHealthState;
  /** ISO. When the engine said it can serve again; the record is spent past it. */
  until?: string;
  reason?: string;
  observedAt?: string;
}

/** Live readings keyed by engine name. An engine with no entry is healthy. */
export type EngineHealthReading = Record<string, EngineHealth>;

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");

/** A stated reopening further out than this is a misparse rather than a quota
 *  window, so clamping turns "retires the engine" into "pauses it for a while". */
const MAX_EXHAUSTION_MS = 12 * 60 * 60_000;

/** How long a failure that stated no reopening stays on the record. It says the
 *  provider just refused a turn, which is worth a brief preference away and is
 *  not worth believing for an afternoon. */
const DEGRADED_WINDOW_MS = 15 * 60_000;

const HEALTH_STATES: readonly string[] = ["ok", "exhausted", "degraded"];

function readStore(): EngineHealthReading {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: EngineHealthReading = {};
    for (const [engine, record] of Object.entries(parsed as Record<string, EngineHealth | null>)) {
      if (record && typeof record === "object" && HEALTH_STATES.includes(record.state)) store[engine] = record;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: EngineHealthReading): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // best-effort only
  }
}

/**
 * Whether a record has outlived what it stated. Expiry is what the clock says
 * rather than what a sweeper got around to, so a record can never outlive its
 * own window — and an `until` that will not parse counts as spent, because
 * fail-open is the only safe direction for advice.
 */
function isSpent(record: EngineHealth, now: Date): boolean {
  if (record.state === "ok") return true;
  if (record.until === undefined) return false;
  const until = Date.parse(record.until);
  return !Number.isFinite(until) || until <= now.getTime();
}

/** Every engine something has been observed about, with a record whose window
 *  has passed reading back as `ok`. */
export function readEngineHealth(now: Date = new Date()): EngineHealthReading {
  const live: EngineHealthReading = {};
  for (const [engine, record] of Object.entries(readStore())) {
    live[engine] = isSpent(record, now)
      ? { state: "ok", ...(record.observedAt ? { observedAt: record.observedAt } : {}) }
      : record;
  }
  return live;
}

/** The one question a dispatcher asks. `degraded` is deliberately not an answer
 *  to it: an engine that named no reopening is a preference, never a reason to
 *  hold a turn back. */
export function isEngineExhausted(health: EngineHealthReading, engine: string): boolean {
  return health[engine]?.state === "exhausted";
}

/**
 * Note that an engine could not serve a turn, given whatever it said about when
 * it can again.
 *
 * A stated reopening is `exhausted` until then, the one reading a dispatcher
 * skips on. Silence is `degraded`, because a failure that named no end says
 * nothing about when to stop believing it.
 */
export function recordEngineUnavailable(
  engine: string,
  reason: string,
  resetsAtSeconds?: number,
  now: Date = new Date(),
): void {
  const stated = resetsAtSeconds !== undefined && Number.isFinite(resetsAtSeconds)
    ? resetsAtSeconds * 1000
    : undefined;
  const window: EngineHealth = stated === undefined
    ? { state: "degraded", until: new Date(now.getTime() + DEGRADED_WINDOW_MS).toISOString() }
    : { state: "exhausted", until: new Date(Math.min(stated, now.getTime() + MAX_EXHAUSTION_MS)).toISOString() };
  writeStore({ ...readStore(), [engine]: { ...window, reason, observedAt: now.toISOString() } });
}

/**
 * The same fact a failed turn would have carried, minus the failed turn: a quota
 * window the provider itself reports as fully spent. When several are spent the
 * engine is back only once the last of them reopens.
 */
export function recordExhaustedWindows(
  engine: string,
  windows: readonly EngineLimitWindow[] | undefined,
  now: Date = new Date(),
): void {
  let reopensAt = 0;
  for (const window of windows ?? []) {
    if ((window.usedPercent ?? 0) < 100) continue;
    const resetsAt = window.resetsAt ?? 0;
    if (resetsAt * 1000 > now.getTime()) reopensAt = Math.max(reopensAt, resetsAt);
  }
  if (reopensAt > 0) recordEngineUnavailable(engine, "quota window spent", reopensAt, now);
}

/**
 * The first engine in `from`'s chain that can take the turn: one the caller
 * accepts AND whose allowance has not run out.
 *
 * A chain the health filter empties is walked again without it. Installed
 * availability stays the only hard gate, so a record that has gone stale can
 * reorder a chain but can never empty one the caller would have accepted.
 */
export function resolveHealthyFallbackEngine(
  config: JinnConfig,
  from: string,
  isUsable: (engine: EngineName) => boolean,
  health: EngineHealthReading,
): EngineName | null {
  return resolveFallbackEngine(config, from, (engine) => isUsable(engine) && !isEngineExhausted(health, engine))
    ?? resolveFallbackEngine(config, from, isUsable);
}

/** The registry as an API consumer reads it: installed availability from the
 *  registry, the live reading beside it. */
export function withEngineHealth(
  registry: ModelRegistry,
): Record<string, ModelRegistry[string] & { health: EngineHealth }> {
  const health = readEngineHealth();
  return Object.fromEntries(Object.entries(registry).map(([name, entry]) => [
    name,
    { ...entry, health: health[name] ?? { state: "ok" as const } },
  ]));
}
