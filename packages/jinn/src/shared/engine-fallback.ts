import { ENGINE_NAMES, isKnownEngine, type EngineName } from "./models.js";
import type { JinnConfig } from "./types.js";

const KNOWN_ENGINES = ENGINE_NAMES.join(", ");

/**
 * Problems with the `fallback` chains under an `engines` mapping (empty = valid).
 * Unknown names and self-references are refused because a chain naming a typo would
 * fail silently — it simply never fires — rather than loudly. Cycles across engines
 * are deliberately accepted: they are how "either of these two" reads in config, and
 * the runtime walker carries a visited set.
 */
export function validateEngineFallbackChains(engines: Record<string, unknown>): string[] {
  const problems: string[] = [];

  for (const name of ENGINE_NAMES) {
    const section = engines[name];
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;

    const chain = (section as { fallback?: unknown }).fallback;
    if (chain === undefined) continue;
    if (!Array.isArray(chain)) {
      problems.push(`engines.${name}.fallback must be a list of engine names (got ${typeof chain})`);
      continue;
    }

    chain.forEach((entry, index) => {
      if (typeof entry !== "string") {
        problems.push(`engines.${name}.fallback[${index}] must be a string (got ${typeof entry})`);
      } else if (entry === name) {
        problems.push(`engines.${name}.fallback must not name ${name} itself`);
      } else if (!isKnownEngine(entry)) {
        problems.push(`engines.${name}.fallback[${index}] "${entry}" is not a known engine (${KNOWN_ENGINES})`);
      }
    });
  }

  return problems;
}

// Warn once per mapped engine: loadConfig() runs again on every config hot-reload, so
// one legacy config would otherwise repeat itself through the whole gateway lifetime.
const warnedLegacyFallbackEngines = new Set<string>();

/**
 * Map the deprecated `sessions.rateLimitStrategy: "fallback"` / `sessions.fallbackEngine`
 * pair onto `engines.claude.fallback`, in place. An explicit chain always wins, an
 * explicit empty one included — that is an operator saying "no fallback" in the current
 * spelling. Both legacy keys are left on the config so whatever still reads them keeps
 * behaving exactly as it did.
 */
export function applyLegacyFallbackMigration(
  config: JinnConfig,
  warn: (message: string) => void = console.warn,
): void {
  if (config.sessions?.rateLimitStrategy !== "fallback") return;
  if (config.engines.claude.fallback !== undefined) return;

  const engine: EngineName = config.sessions.fallbackEngine ?? "codex";
  config.engines.claude.fallback = [engine];

  if (warnedLegacyFallbackEngines.has(engine)) return;
  warnedLegacyFallbackEngines.add(engine);
  warn(
    `sessions.rateLimitStrategy and sessions.fallbackEngine are deprecated — ` +
      `write engines.claude.fallback: [${engine}] instead.`,
  );
}

function fallbackChain(config: JinnConfig, engine: string): EngineName[] {
  return config.engines[engine as EngineName]?.fallback ?? [];
}

/**
 * The first engine in `from`'s chain that `isUsable` accepts, continuing through the
 * chain of every engine it rejects. What "usable" means belongs to the caller — the
 * session runtime asks for registered and installed.
 *
 * The visited set is what makes the cycles the validator deliberately allows safe, and
 * it holds `from` from the start so the engine that just failed is never its own answer.
 */
export function resolveFallbackEngine(
  config: JinnConfig,
  from: string,
  isUsable: (engine: EngineName) => boolean,
): EngineName | null {
  const visited = new Set<string>([from]);
  const queue = [...fallbackChain(config, from)];

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (isUsable(candidate)) return candidate;
    queue.push(...fallbackChain(config, candidate));
  }

  return null;
}
