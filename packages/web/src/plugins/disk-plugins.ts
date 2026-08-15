/**
 * The disk door: what turns `~/.jinn/plugins/<id>/` into loaded plugins.
 *
 * The gateway does the discovery — it lists every directory it found and serves
 * the client half of the ones the operator enabled — so this side is a
 * reconciliation, not a second scanner. One pass reads the inventory, unloads
 * what is no longer served, records what is served by nobody, and loads the
 * rest. `.plans/plugins.md` §7 enumerates the hazards each branch below exists
 * for; every one of them has bitten somebody.
 */
import { authFetch } from '@/lib/auth'
import { plugins, type PluginRecord } from '@/contrib/plugins-store'
import { loadRuntimePlugin, unloadRuntimePlugin } from './runtime-loader'

/** `GET /api/plugins`. `plugins` is the enabled subset whose client half the
 *  gateway will serve; `inventory` is every directory it found, disabled and
 *  broken ones included. */
interface PluginsResponse {
  plugins: PluginRecord[]
  inventory: PluginRecord[]
}

/**
 * Gateway id (the folder name) -> the plugin id currently loaded from it, or
 * null when nothing has loaded yet. The two differ the moment an edit changes
 * `plugin.id`, and telling them apart is the whole reason this map exists.
 */
const door = new Map<string, string | null>()
let scanning = false

/**
 * Whether the first reconcile has finished.
 *
 * A deep link to a contributed page is rendered before any plugin has loaded,
 * and a host that answered "no such route" in that window would bounce every
 * plugin bookmark to chat. This is what lets it wait instead.
 */
let settled = false
const settledListeners = new Set<() => void>()

export function diskPluginsSettled(): boolean {
  return settled
}

export function subscribeDiskPluginsSettled(listener: () => void): () => void {
  settledListeners.add(listener)
  return () => void settledListeners.delete(listener)
}

/** Announced once. A pass that fails still settles: "we looked" is the fact the
 *  waiting side needs, not "we found something". */
function markSettled(): void {
  if (settled) return
  settled = true
  for (const listener of [...settledListeners]) listener()
}

/** Take one directory's plugin down: its registrations, its own inventory row,
 *  and the folder-named row a failed load leaves behind. */
function unload(gatewayId: string): void {
  const id = door.get(gatewayId)
  if (id) {
    unloadRuntimePlugin(id)
    plugins.dropPlugin(id)
  }
  plugins.dropPlugin(gatewayId)
  door.delete(gatewayId)
}

/** What the client route answered: the source, the plugin no longer being
 *  served, or a file that is there and would not compile. */
type ClientFetch =
  | { ok: true; source: string }
  | { ok: false; kind: 'gone' }
  | { ok: false; kind: 'error'; message: string }

/** The reason a 422 carries — file, line and message, as the gateway's transform
 *  reported them. */
async function refusalReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // A refusal whose body will not parse is still a refusal. The status is the
    // fact the row needs; falling back keeps it from reading as a success.
  }
  return 'the gateway could not compile this plugin’s client half'
}

/** The client source, or why there is none. Only a 422 says the plugin is
 *  installed and broken; every other refusal — unknown, disabled, or missing its
 *  client half — means "not installed now". */
async function fetchClient(id: string): Promise<ClientFetch> {
  const response = await authFetch(`/api/plugins/${encodeURIComponent(id)}/client`)
  if (response.ok) return { ok: true, source: await response.text() }
  if (response.status !== 422) return { ok: false, kind: 'gone' }
  return { ok: false, kind: 'error', message: await refusalReason(response) }
}

/** What a refusal leaves behind in the dashboard. The two are not the same
 *  absence: one plugin stopped being installed, the other is installed and will
 *  not compile, and a plugin that vanished when it broke is one nobody can fix. */
function recordRefusal(row: PluginRecord, refusal: Extract<ClientFetch, { ok: false }>): void {
  if (refusal.kind === 'gone') {
    // Gone between the listing and the fetch. That is an unload, not a load
    // error: a plugin that is no longer there did not fail at anything.
    unload(row.id)
    return
  }
  // Broken, and still installed. It keeps its row — carrying the file and line
  // its author has to fix — and whatever version is already running keeps
  // running, because unloading it would take the working page down too.
  plugins.publishPlugin({ ...row, status: 'error', error: refusal.message })
}

async function loadFromGateway(row: PluginRecord): Promise<void> {
  let client: ClientFetch
  try {
    client = await fetchClient(row.id)
  } catch (error) {
    // The gateway became unreachable mid-pass. Leaving the plugin exactly as it
    // is beats both unloading a live one and blaming it for the network.
    console.warn(`[plugins] could not fetch ${row.id}`, error)
    return
  }

  if (!client.ok) {
    recordRefusal(row, client)
    return
  }

  const source = client.source
  const previous = door.get(row.id) ?? null
  const id = await loadRuntimePlugin(source, row.id, row.kind)

  // A hot edit that changed `plugin.id`. The loader only ever sees the id it
  // just read, so the previous incarnation's contributions and inventory row
  // are this function's to take down.
  if (id && previous && previous !== id) {
    unloadRuntimePlugin(previous)
    plugins.dropPlugin(previous)
  }

  // Loaded under an id that is not the folder name: an earlier failed load
  // recorded itself under the folder, and that row would sit beside the real
  // one as a ghost.
  if (id && id !== row.id) plugins.dropPlugin(row.id)

  // A failed load keeps tracking the previous id, so the save that fixes it can
  // still dispose what is live.
  door.set(row.id, id ?? previous)
}

/**
 * Point the dashboard's own store at the operator's decision.
 *
 * The gateway's servable list IS that decision, as `config.yaml` records it, and
 * `config.yaml` is the only place it is made. Following it here keeps the store
 * a CACHE of the decision rather than a second one nothing ever writes: without
 * this, a plugin the operator enabled was fetched, evaluated and published, and
 * then never registered, because the store held no opt-in for it and absence is
 * not enabled.
 */
async function followOperatorDecision(
  inventory: readonly PluginRecord[],
  servableIds: ReadonlySet<string>,
): Promise<void> {
  for (const row of inventory) {
    const enabled = servableIds.has(row.id)
    if (plugins.pluginActive(row.id) !== enabled) await plugins.setPluginEnabled(row.id, enabled)
  }
}

/**
 * Reconcile the loaded plugins with what the gateway serves. Safe to call as
 * often as anything asks: a pass already in flight makes this a no-op.
 */
export async function scanDiskPlugins(): Promise<void> {
  // Fetches and dynamic imports outrun any debounce, so overlapping passes are
  // a matter of when rather than if — and two passes over one directory load it
  // twice. A guard, not a longer interval.
  if (scanning) return
  scanning = true

  try {
    const response = await authFetch('/api/plugins')
    if (!response.ok) throw new Error(`the gateway answered ${response.status}`)
    const { plugins: servable, inventory } = (await response.json()) as PluginsResponse
    const servableIds = new Set(servable.map((row) => row.id))

    // Before the loads below, so the loader sees the decision when it decides
    // whether to register.
    await followOperatorDecision(inventory, servableIds)

    // Deleted, or disabled while it was running. Either way it stops being
    // registered before the inventory below says what it is now.
    for (const gatewayId of [...door.keys()]) {
      if (!servableIds.has(gatewayId)) unload(gatewayId)
    }

    // Everything the gateway knows about but will not serve still inventories:
    // disabled and broken are states, not absences, and a plugin that vanished
    // from the list when it broke would be one nobody could fix.
    for (const row of inventory) {
      if (!servableIds.has(row.id)) plugins.publishPlugin(row)
    }

    for (const row of servable) await loadFromGateway(row)
  } catch (error) {
    // No gateway, no plugins directory, or an answer we cannot read. Absent is
    // zero plugins; it leaves what is already loaded alone.
    console.warn('[plugins] could not read the plugin inventory', error)
  } finally {
    scanning = false
    markSettled()
  }
}
