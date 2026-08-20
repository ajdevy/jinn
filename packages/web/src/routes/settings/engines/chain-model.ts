import type { EngineHealth } from "@/lib/api"

/** One engine's block under `engines.` in config.yaml. */
export interface EngineSettings {
  bin?: string
  model?: string
  effortLevel?: string
  fallback?: string[]
}

/** The `engines` block. `default` names an engine; every other key is one. */
export interface EnginesConfig {
  default?: string
  claude?: EngineSettings
  codex?: EngineSettings
  grok?: EngineSettings
  [engine: string]: EngineSettings | string | undefined
}

/** The legacy pair this section replaces. Both are nulled on migration. */
export interface SessionsFallbackConfig {
  rateLimitStrategy?: "wait" | "fallback" | null
  fallbackEngine?: string | null
}

/** An engine name as the operator reads it, matching the Default Engine picker. */
export function engineLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function chainFor(engines: EnginesConfig | undefined, engine: string): string[] {
  const entry = engines?.[engine]
  return (typeof entry === "object" ? entry.fallback : undefined) ?? []
}

/** Engines the add control may offer: never the card's own engine, never one
 *  the chain already holds. Both are rejected by the gateway's validator, so
 *  offering them would only produce a save that fails. */
export function addOptionsFor(registryEngines: string[], engine: string, chain: string[]): string[] {
  return registryEngines.filter((name) => name !== engine && !chain.includes(name))
}

export function removeFromChain(chain: string[], index: number): string[] {
  return chain.filter((_, i) => i !== index)
}

/** Move one entry, keeping every other entry's relative order. An index outside
 *  the chain returns it unchanged rather than dropping or duplicating an entry. */
export function moveInChain(chain: string[], from: number, to: number): string[] {
  if (from === to) return chain
  if (from < 0 || from >= chain.length || to < 0 || to >= chain.length) return chain
  const next = [...chain]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export type EngineHealthTone = "healthy" | "exhausted" | "degraded"

export interface EngineHealthDisplay {
  tone: EngineHealthTone
  label: string
}

/** How a health record reads on a card. No record at all means healthy: the
 *  reading is advisory, and an engine nobody has observed failing is fine. */
export function classifyEngineHealth(health: EngineHealth | undefined): EngineHealthDisplay {
  if (health?.state === "degraded") return { tone: "degraded", label: "Degraded" }
  if (health?.state !== "exhausted") return { tone: "healthy", label: "Healthy" }
  const until = formatUntil(health.until)
  return { tone: "exhausted", label: until ? `Out of allowance until ${until}` : "Out of allowance" }
}

/** The ISO reopening as a local clock time, or null when it is absent or is not
 *  a date — a record written by a misparse should read as "no time", not "Invalid Date". */
function formatUntil(until: string | undefined): string | null {
  if (!until) return null
  const at = new Date(until)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/** A path/value pair for the Settings page's `updateConfig`. */
export interface ConfigMutation {
  path: string[]
  value: unknown
}

/** The engine `sessions.rateLimitStrategy: "fallback"` maps Claude onto, or null
 *  when no legacy mapping is configured. */
export function legacyFallbackEngine(sessions: SessionsFallbackConfig | undefined): string | null {
  if (sessions?.rateLimitStrategy !== "fallback") return null
  return sessions.fallbackEngine ?? null
}

/** Migrating the legacy pair onto a real chain. The two legacy keys are set to
 *  null rather than dropped because the gateway's config merge keeps any key the
 *  PUT omits — only an explicit null deletes one. */
export function legacyMigrationMutations(fallbackEngine: string): ConfigMutation[] {
  return [
    { path: ["engines", "claude", "fallback"], value: [fallbackEngine] },
    { path: ["sessions", "rateLimitStrategy"], value: null },
    { path: ["sessions", "fallbackEngine"], value: null },
  ]
}
