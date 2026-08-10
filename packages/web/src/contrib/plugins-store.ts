import type { KVStore } from "@/lib/view-mode"

/** Whether a plugin ships a gateway half as well as a dashboard one. */
export type PluginKind = "client" | "client+server"

export type PluginStatus = "loaded" | "disabled" | "error"

/**
 * What the settings list shows for one plugin. A plugin that failed to load
 * keeps its record and carries the reason: one that vanished from the list when
 * it broke would be one nobody could fix.
 */
export interface PluginRecord {
  id: string
  name: string
  kind: PluginKind
  status: PluginStatus
  /** Why it failed, when `status` is `"error"`. */
  error?: string
}

/** The loader's controls for one plugin, so a toggle never needs a reload. */
export interface PluginHandle {
  activate: () => Promise<void> | void
  deactivate: () => void
}

const DECISIONS_KEY = "jinn-plugin-decisions"

function defaultStore(): KVStore | null {
  return typeof localStorage !== "undefined" ? localStorage : null
}

function readDecisions(store: KVStore | null): Record<string, boolean> {
  const raw = store?.getItem(DECISIONS_KEY)
  if (!raw) return {}

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, enabled]) => typeof enabled === "boolean"),
    ) as Record<string, boolean>
  } catch {
    // Storage we cannot read is read as no decisions at all. That is also the
    // fail-closed answer, because absence disables — a corrupt map can lose an
    // opt-in, but it can never turn a plugin on by accident.
    return {}
  }
}

/**
 * The inventory of known plugins and the operator's explicit enable/disable
 * decisions.
 *
 * **Absence is not enabled.** Only an explicit `true` activates a plugin, and
 * there is no manifest default to fall back to — a value the plugin ships that
 * flipped it on would be the plugin opting itself in.
 */
export class PluginStore {
  private readonly store: KVStore | null
  private readonly records = new Map<string, PluginRecord>()
  private readonly handles = new Map<string, PluginHandle>()
  private decisions: Record<string, boolean>

  constructor(store: KVStore | null = defaultStore()) {
    this.store = store
    this.decisions = readDecisions(store)
  }

  /** Whether a plugin may register. Only an explicit `true` says yes. */
  pluginActive = (id: string): boolean => this.decisions[id] === true

  /** Every plugin the app knows about, disabled and broken ones included. */
  listPlugins = (): readonly PluginRecord[] => [...this.records.values()]

  /** Publish or refresh a plugin's record, plus its lifecycle handles if it has any. */
  publishPlugin = (record: PluginRecord, handle?: PluginHandle): void => {
    this.records.set(record.id, record)
    if (handle) this.handles.set(record.id, handle)
  }

  /** Update a known plugin. An unknown id is ignored — a patch cannot invent a plugin. */
  patchPlugin = (id: string, patch: Partial<PluginRecord>): void => {
    const current = this.records.get(id)
    if (!current) return
    this.records.set(id, { ...current, ...patch })
  }

  dropPlugin = (id: string): void => {
    this.records.delete(id)
    this.handles.delete(id)
  }

  /**
   * Record the decision and make it true straight away, so a toggle needs no
   * reload. Persisting first means storage that refuses the write leaves the
   * plugin exactly as it was, rather than running a lifecycle the next reload
   * would silently undo.
   */
  setPluginEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const next = { ...this.decisions, [id]: enabled }
    this.store?.setItem(DECISIONS_KEY, JSON.stringify(next))
    this.decisions = next

    const handle = this.handles.get(id)
    if (!handle) return

    if (enabled) {
      await handle.activate()
      return
    }
    handle.deactivate()
    this.patchPlugin(id, { status: "disabled" })
  }
}

export const plugins = new PluginStore()
