import type { Engine, EngineResult, JinnConfig } from "./types.js";
import { engineAvailable, isKnownEngine, type EngineName } from "./models.js";

/** Failures that mean the provider/transport is unavailable for this turn. */
const PROVIDER_FAILURE_RE = /\b(?:server_error|api_error|overloaded_error|authentication_failed|billing_error|unauthorized|forbidden|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b|socket hang up|fetch failed|network error|bad gateway|service unavailable|gateway time-?out|internal server error|\b(?:HTTP|status)(?:\s+code)?\s*[:=]?\s*5\d\d\b/i;

/** A provider failure is safe to retry only when it produced no answer text. */
export function isProviderFailure(result: Pick<EngineResult, "result" | "error">): boolean {
  return typeof result.error === "string"
    && result.error.trim().length > 0
    && typeof result.result === "string"
    && result.result.trim().length === 0
    && PROVIDER_FAILURE_RE.test(result.error);
}

type EngineSection = { fallback?: unknown };

function fallbackChain(config: JinnConfig, engine: string): unknown[] {
  const section = (config.engines as unknown as Record<string, EngineSection | undefined>)[engine];
  return Array.isArray(section?.fallback) ? section.fallback : [];
}

/** Resolve the first installed, registered engine in the configured chain. */
export function resolveProviderFallback(
  config: JinnConfig,
  from: string,
  engines: Map<string, Engine>,
): string | undefined {
  const visited = new Set<string>([from]);
  const queue = fallbackChain(config, from);

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (typeof candidate !== "string" || visited.has(candidate)) continue;
    visited.add(candidate);
    if (!isKnownEngine(candidate)) continue;
    if (engines.has(candidate) && engineAvailable(config, candidate as EngineName)) return candidate;
    queue.push(...fallbackChain(config, candidate));
  }

  return undefined;
}
