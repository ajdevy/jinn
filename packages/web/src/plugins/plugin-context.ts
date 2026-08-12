/**
 * The plugin authoring contract, and the scoped context a plugin registers
 * through.
 *
 * A plugin never reaches the registry itself — it only ever holds a
 * `PluginContext`, whose `contribute` namespaces the id and stamps the source
 * on the way past. That is what makes `.plans/plugins.md` §3's rule true rather
 * than merely stated: an author has no way to write `source`, and no way to
 * spell an id outside their own namespace.
 */
import { contributions } from '@/contrib/registry'
import type { Contribution, ContributionSource } from '@/contrib/types'
import { authFetch } from '@/lib/auth'
import type { KVStore } from '@/lib/view-mode'

/** Namespaced JSON persistence. Keys live under `jinn.plugin.<id>.`, so one
 *  plugin can neither read nor clobber another's. */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

export interface PluginContext {
  /** The tag this context stamps, e.g. `plugin:cost-meter`. */
  readonly source: ContributionSource
  /** Register one contribution. Its `id` is local — the host namespaces it. */
  contribute: (contribution: Contribution) => () => void
  /** Register several at once; the returned disposer removes all of them. */
  contributeMany: (contributions: readonly Contribution[]) => () => void
  /** Register a cleanup for a side effect that is not a contribution — a timer,
   *  a subscription — so unload and reload take it down with everything else. */
  onDispose: (dispose: () => void) => void
  storage: PluginStorage
  /** Call this plugin's own backend, at a path relative to its mount. A plugin
   *  cannot spell another's prefix, because it never supplies the id. */
  backend: (suffix: string, init?: RequestInit) => Promise<Response>
}

/**
 * Does this segment read as `..` to the URL parser?
 *
 * `%2e` decodes to `.` during path normalization, so WHATWG URL collapses four
 * spellings — `..`, `.%2e`, `%2e.`, `%2e%2e` — and a literal-only check leaves
 * three ways to walk out of the mount that `fetch` still honours. `%2e%2e%2e` is
 * not one of them: three dots is an ordinary segment, and refusing it would
 * refuse a legal path.
 */
function isParentSegment(segment: string): boolean {
  return segment.toLowerCase().replaceAll('%2e', '.') === '..'
}

/**
 * `/api/plugins/<id><suffix>`, refusing rather than rewriting a suffix that
 * walks out of the plugin's own mount.
 *
 * The check reads the path alone — everything before `?` or `#` — because a
 * relative path passed as a query *value* is a legitimate thing to send, and
 * only the path decides what the request reaches. Sanitizing would answer a
 * different request than the caller wrote, which is a bug that reaches
 * production; throwing is one that does not.
 */
export function pluginBackendPath(pluginId: string, suffix: string): string {
  const [routePath = ''] = suffix.split(/[?#]/, 1)
  if (routePath.split('/').some(isParentSegment)) {
    throw new Error(
      `[plugin] "${suffix}" contains a ".." segment, encoded or not, and would leave ` +
        `/api/plugins/${pluginId}/. Pass a path relative to the plugin mount, without ".." segments.`,
    )
  }
  return `/api/plugins/${pluginId}${suffix}`
}

/** What a plugin's `client.js` default-exports. */
export interface JinnPlugin {
  /** Stable slug. It becomes the `plugin:<id>` source and the id namespace. */
  id: string
  /** Human name for the settings list. Defaults to `id`. */
  name?: string
  /**
   * Accepted for shape and then ignored. Enablement is the operator's decision
   * alone (`.plans/plugins.md` §8): a value the plugin ships that flipped it on
   * would be the plugin opting itself in. The field is validated rather than
   * dropped so an author who writes it gets told, instead of watching it do
   * nothing.
   */
  defaultEnabled?: boolean
  /** Called once per activation; wire contributions through `ctx`. */
  register: (ctx: PluginContext) => void
}

function defaultStore(): KVStore | null {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function createPluginStorage(pluginId: string, store: KVStore | null): PluginStorage {
  const scoped = (key: string) => `jinn.plugin.${pluginId}.${key}`

  return {
    get(key, fallback) {
      const raw = store?.getItem(scoped(key))
      if (raw === null || raw === undefined) return fallback

      try {
        return JSON.parse(raw) as typeof fallback
      } catch {
        // A value we cannot parse is one we cannot honour. The fallback is the
        // plugin's own stated answer for "nothing stored", which is the closest
        // true thing to say about a value that is there but unreadable.
        return fallback
      }
    },
    set: (key, value) => store?.setItem(scoped(key), JSON.stringify(value)),
  }
}

/**
 * Build the context handed to one plugin's `register`. `track` receives every
 * disposer the plugin accumulates, which is how the loader takes an incarnation
 * back down on unload or reload.
 */
export function createPluginContext(
  pluginId: string,
  track?: (dispose: () => void) => void,
  store: KVStore | null = defaultStore(),
): PluginContext {
  const source: ContributionSource = `plugin:${pluginId}`
  const scope = (contribution: Contribution): Contribution => ({
    ...contribution,
    id: `${pluginId}:${contribution.id}`,
  })

  const tracked = (dispose: () => void) => {
    track?.(dispose)
    return dispose
  }

  return {
    source,
    contribute: (contribution) => tracked(contributions.register(scope(contribution), source)),
    contributeMany: (batch) => tracked(contributions.registerMany(batch.map(scope), source)),
    onDispose: (dispose) => void tracked(dispose),
    storage: createPluginStorage(pluginId, store),
    backend: (suffix, init) => authFetch(pluginBackendPath(pluginId, suffix), init),
  }
}
