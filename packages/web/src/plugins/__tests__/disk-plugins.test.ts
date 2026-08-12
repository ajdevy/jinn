import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugins, type PluginRecord } from '@/contrib/plugins-store'
import { contributions } from '@/contrib/registry'
import { scanDiskPlugins } from '../disk-plugins'
import { useDataUrlModules } from './data-url-modules'

const authFetch = vi.fn()
vi.mock('@/lib/auth', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

beforeAll(() => {
  useDataUrlModules()
})

beforeEach(() => {
  authFetch.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// Both the registry and the plugin store are singletons, so each test works
// under a folder name and an area of its own.
let counter = 0
function fresh(): { folder: string; area: string } {
  counter += 1
  return { folder: `folder-${counter}`, area: `disk.plugins.area.${counter}` }
}

const recordFor = (id: string) => plugins.listPlugins().find((record) => record.id === id)

function row(id: string, patch: Partial<PluginRecord> = {}): PluginRecord {
  return { id, name: id, kind: 'client', status: 'loaded', ...patch }
}

function chipPlugin(id: string, area: string, local = 'chip'): string {
  return `export default {
  id: ${JSON.stringify(id)},
  register(ctx) { ctx.contribute({ id: ${JSON.stringify(local)}, area: ${JSON.stringify(area)} }); },
};
`
}

/** Answer as the gateway does: an inventory, and a client half per folder that
 *  has one. A folder mapped to null 404s, which is what the gateway says for
 *  unknown, disabled, or missing. */
function gatewayServes(inventory: PluginRecord[], clients: Record<string, string | null>): void {
  authFetch.mockImplementation((path: string) => {
    if (path === '/api/plugins') {
      const servable = inventory.filter((entry) => entry.status === 'loaded')
      return Promise.resolve(Response.json({ plugins: servable, inventory }))
    }

    const id = /^\/api\/plugins\/(.+)\/client$/.exec(path)?.[1]
    const source = id ? clients[id] : undefined
    return Promise.resolve(
      source == null ? new Response('', { status: 404 }) : new Response(source, { status: 200 }),
    )
  })
}

describe('the operator’s decision', () => {
  // `config.yaml` is where enablement is decided, and the gateway's servable
  // list is that decision. Before the store followed it, a plugin the operator
  // enabled was fetched, evaluated and published, and then never registered,
  // because nothing in the app had ever written the store's own opt-in.
  it('registers a plugin the gateway serves without any stored decision', async () => {
    const { folder, area } = fresh()
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })

    await scanDiskPlugins()

    expect(plugins.pluginActive(folder)).toBe(true)
    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([`${folder}:chip`])
  })

  it('takes the decision back when the gateway stops serving it', async () => {
    const { folder, area } = fresh()
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    gatewayServes([row(folder, { status: 'disabled' })], { [folder]: null })
    await scanDiskPlugins()

    expect(plugins.pluginActive(folder)).toBe(false)
    expect(contributions.getArea(area)).toEqual([])
  })
})

describe('one pass', () => {
  it('loads what the gateway serves', async () => {
    const { folder, area } = fresh()
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })

    await scanDiskPlugins()

    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([`${folder}:chip`])
    expect(recordFor(folder)?.status).toBe('loaded')
  })

  it('inventories what it will not serve, without registering it', async () => {
    const { folder } = fresh()
    const off = `${folder}-off`
    const broken = `${folder}-broken`
    gatewayServes(
      [
        row(off, { status: 'disabled' }),
        row(broken, { status: 'error', error: 'client.js is missing' }),
      ],
      {},
    )

    await scanDiskPlugins()

    expect(recordFor(off)).toEqual(row(off, { status: 'disabled' }))
    expect(recordFor(broken)).toEqual(row(broken, { status: 'error', error: 'client.js is missing' }))
  })

  it('leaves what is loaded alone when the gateway cannot be read', async () => {
    const { folder, area } = fresh()
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    authFetch.mockRejectedValue(new Error('gateway is down'))
    await expect(scanDiskPlugins()).resolves.toBeUndefined()

    expect(contributions.getArea(area)).toHaveLength(1)
  })
})

describe('a hot edit that changes the plugin id', () => {
  it('disposes the previous id, not just the new one', async () => {
    const { folder, area } = fresh()
    const renamed = `${folder}-renamed`
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()
    expect(contributions.getArea(area)).toHaveLength(1)

    gatewayServes([row(folder)], { [folder]: chipPlugin(renamed, area) })
    await scanDiskPlugins()

    // The previous incarnation is gone: its contributions and its inventory row.
    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(folder)).toBeUndefined()
    expect(recordFor(renamed)?.status).toBe('disabled')
  })

  it('drops the folder-named error record when the fixing save loads under another id', async () => {
    const { folder, area } = fresh()
    const fixed = `${folder}-fixed`
    gatewayServes([row(folder)], { [folder]: 'export default 1;' })
    await scanDiskPlugins()
    expect(recordFor(folder)?.status).toBe('error')

    gatewayServes([row(folder)], { [folder]: chipPlugin(fixed, area) })
    await scanDiskPlugins()

    // One row, not a ghost beside it.
    expect(recordFor(folder)).toBeUndefined()
    expect(recordFor(fixed)?.status).toBe('disabled')
  })
})

describe('folders that go away', () => {
  it('unloads a folder that disappears mid-pass rather than blaming it', async () => {
    const { folder, area } = fresh()
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    // Listed, then 404 on the client fetch — deleted between the two calls.
    gatewayServes([row(folder)], {})
    await scanDiskPlugins()

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(folder)).toBeUndefined()
  })

  it('unloads a folder that is gone from the next inventory', async () => {
    const { folder, area } = fresh()
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    gatewayServes([], {})
    await scanDiskPlugins()

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(folder)).toBeUndefined()
  })

  it('keeps the inventory row when a running plugin is disabled at the gateway', async () => {
    const { folder, area } = fresh()
    await plugins.setPluginEnabled(folder, true)
    gatewayServes([row(folder)], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    gatewayServes([row(folder, { status: 'disabled' })], { [folder]: chipPlugin(folder, area) })
    await scanDiskPlugins()

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(folder)).toEqual(row(folder, { status: 'disabled' }))
  })
})

describe('the scanning guard', () => {
  it('makes a rescan during a pass a no-op rather than an overlap', async () => {
    const { folder, area } = fresh()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const inventory = Response.json({ plugins: [row(folder)], inventory: [row(folder)] })
    authFetch.mockImplementation(async (path: string) => {
      if (path !== '/api/plugins') return new Response(chipPlugin(folder, area), { status: 200 })
      await held
      return inventory
    })

    const first = scanDiskPlugins()
    await expect(scanDiskPlugins()).resolves.toBeUndefined()

    // The second call returned without so much as asking the gateway.
    expect(authFetch).toHaveBeenCalledTimes(1)

    release()
    await first
    expect(authFetch).toHaveBeenCalledWith('/api/plugins')
  })
})
