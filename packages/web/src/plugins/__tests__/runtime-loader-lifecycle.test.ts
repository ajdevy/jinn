import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@/plugins/sdk'
import { plugins } from '@/contrib/plugins-store'
import { contributions } from '@/contrib/registry'
import { loadRuntimePlugin, unloadRuntimePlugin } from '../runtime-loader'
import { useDataUrlModules } from './data-url-modules'

beforeAll(() => {
  useDataUrlModules()
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// The registry and the plugin store are both singletons, so every test works
// under an id and an area of its own.
let counter = 0
function fresh(): { id: string; area: string } {
  counter += 1
  return { id: `live-${counter}`, area: `runtime.loader.area.${counter}` }
}

const recordFor = (id: string) => plugins.listPlugins().find((record) => record.id === id)

/** A plugin that contributes one chip, written the way a disk plugin is: plain
 *  ESM, no JSX, importing nothing but the SDK. */
function chipPlugin(id: string, area: string, local = 'chip'): string {
  return `import { SDK_CONTRACT_VERSION, React } from '@jinn/plugin-sdk';
export default {
  id: ${JSON.stringify(id)},
  name: 'Chip',
  register(ctx) {
    ctx.contribute({
      id: ${JSON.stringify(local)},
      area: ${JSON.stringify(area)},
      data: { version: SDK_CONTRACT_VERSION, react: React },
    });
  },
};
`
}

describe('a valid plugin', () => {
  it('evaluates, registers, and lands namespaced and stamped', async () => {
    const { id, area } = fresh()
    await plugins.setPluginEnabled(id, true)

    expect(await loadRuntimePlugin(chipPlugin(id, area), id, 'client')).toBe(id)

    const [entry] = contributions.getArea(area)
    expect(entry.id).toBe(`${id}:chip`)
    expect(entry.source).toBe(`plugin:${id}`)
    expect(recordFor(id)).toEqual({ id, name: 'Chip', kind: 'client', status: 'loaded' })

    unloadRuntimePlugin(id)
  })

  // The shim is the whole reason the SDK resolves at all, and the React it
  // hands over has to be the app's own instance — a second one would give the
  // plugin a second dispatcher and every hook it called would throw.
  it('reaches the app’s own SDK and React through the shim', async () => {
    const { id, area } = fresh()
    await plugins.setPluginEnabled(id, true)

    await loadRuntimePlugin(chipPlugin(id, area), id, 'client')

    expect(contributions.getArea(area)[0].data).toEqual({
      version: sdk.SDK_CONTRACT_VERSION,
      react: sdk.React,
    })

    unloadRuntimePlugin(id)
  })

  it('cannot land an id outside its own namespace', async () => {
    const { id, area } = fresh()
    const other = fresh().id
    await plugins.setPluginEnabled(id, true)

    await loadRuntimePlugin(chipPlugin(id, area, `${other}:chip`), id, 'client')

    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([`${id}:${other}:chip`])

    unloadRuntimePlugin(id)
  })
})

describe('reload', () => {
  /** Records its disposals on a global so an evaluated module can be observed. */
  function disposingPlugin(id: string, area: string, local: string, log: string): string {
    return `export default {
  id: ${JSON.stringify(id)},
  register(ctx) {
    ctx.contribute({ id: ${JSON.stringify(local)}, area: ${JSON.stringify(area)} });
    ctx.onDispose(() => { globalThis[${JSON.stringify(log)}].push('first'); });
    ctx.onDispose(() => { throw new Error('a plugin cleanup that throws'); });
    ctx.onDispose(() => { globalThis[${JSON.stringify(log)}].push('second'); });
  },
};
`
  }

  it('disposes the previous incarnation before the new one registers', async () => {
    const { id, area } = fresh()
    const log = `disposals_${counter}`
    ;(globalThis as Record<string, unknown>)[log] = []
    await plugins.setPluginEnabled(id, true)

    await loadRuntimePlugin(disposingPlugin(id, area, 'one', log), id, 'client')
    await loadRuntimePlugin(disposingPlugin(id, area, 'two', log), id, 'client')

    // Only the reload's contribution survives. Without the dispose, `one` and
    // `two` are different ids and both would still be registered.
    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([`${id}:two`])
    // Every disposer ran, including the two either side of one that threw.
    expect((globalThis as Record<string, unknown>)[log]).toEqual(['first', 'second'])

    unloadRuntimePlugin(id)
  })

  it('does not double-register a contribution that keeps its id', async () => {
    const { id, area } = fresh()
    await plugins.setPluginEnabled(id, true)

    await loadRuntimePlugin(chipPlugin(id, area), id, 'client')
    await loadRuntimePlugin(`// edited\n${chipPlugin(id, area)}`, id, 'client')

    expect(contributions.getArea(area)).toHaveLength(1)

    unloadRuntimePlugin(id)
  })

  it('leaves nothing registered after an unload', async () => {
    const { id, area } = fresh()
    await plugins.setPluginEnabled(id, true)
    await loadRuntimePlugin(chipPlugin(id, area), id, 'client')

    unloadRuntimePlugin(id)

    expect(contributions.getArea(area)).toEqual([])
  })
})

describe('a register() that throws', () => {
  it('records the reason without taking the load down', async () => {
    const { id } = fresh()
    await plugins.setPluginEnabled(id, true)
    const source = `export default {
  id: ${JSON.stringify(id)},
  register() { throw new Error('register blew up'); },
};
`

    await expect(loadRuntimePlugin(source, id, 'client')).resolves.toBe(id)

    expect(recordFor(id)).toEqual({
      id,
      name: id,
      kind: 'client',
      status: 'error',
      error: 'register blew up',
    })
  })
})

describe('enablement', () => {
  it('inventories a plugin the operator has not enabled without registering it', async () => {
    const { id, area } = fresh()

    expect(await loadRuntimePlugin(chipPlugin(id, area), id, 'client')).toBe(id)

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(id)).toEqual({ id, name: 'Chip', kind: 'client', status: 'disabled' })
  })

  it('registers live through the published handle when the operator enables it', async () => {
    const { id, area } = fresh()
    await loadRuntimePlugin(chipPlugin(id, area), id, 'client')

    await plugins.setPluginEnabled(id, true)

    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([`${id}:chip`])
    expect(recordFor(id)?.status).toBe('loaded')

    await plugins.setPluginEnabled(id, false)

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(id)?.status).toBe('disabled')
  })

  // `.plans/plugins.md` §8: only the operator enables a plugin. A manifest or
  // module value that flipped it on would be the plugin opting itself in.
  it('does not let a plugin enable itself with defaultEnabled', async () => {
    const { id, area } = fresh()
    const source = chipPlugin(id, area).replace('name:', 'defaultEnabled: true,\n  name:')

    expect(await loadRuntimePlugin(source, id, 'client')).toBe(id)

    expect(contributions.getArea(area)).toEqual([])
    expect(recordFor(id)?.status).toBe('disabled')
  })
})
