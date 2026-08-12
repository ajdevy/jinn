import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { contributions } from '@/contrib/registry'
import { AREAS } from '@/contrib/types'
import { plugins } from '@/contrib/plugins-store'
import { loadRuntimePlugin, unloadRuntimePlugin } from '../runtime-loader'
import { useDataUrlModules } from './data-url-modules'

/**
 * The reference plugin's client half, taken through the shipped loader.
 *
 * The source is the file in `examples/plugins/inbox-demo/`, not a fixture, so
 * this is what pins the demo to the loader's import allowlist: the day it grows
 * an import the allowlist does not cover, the loader rejects it and this fails
 * rather than a reader discovering it.
 */

const DEMO_CLIENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../examples/plugins/inbox-demo/client.js',
)

const source = readFileSync(DEMO_CLIENT, 'utf-8')

function contributionIn(area: string): { id: string; source: string } | undefined {
  return contributions.getArea(area).find((entry) => entry.source === 'plugin:inbox-demo')
}

beforeAll(() => {
  useDataUrlModules()
})

beforeEach(async () => {
  unloadRuntimePlugin('inbox-demo')
  // What `disk-plugins.ts` records from the gateway's servable list before it
  // hands a source to the loader.
  await plugins.setPluginEnabled('inbox-demo', true)
})

describe('examples/plugins/inbox-demo/client.js', () => {
  it('loads through the runtime loader under its own id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await loadRuntimePlugin(source, 'inbox-demo', 'client+server')).toBe('inbox-demo')

    expect(error).not.toHaveBeenCalled()
    expect(plugins.listPlugins().find((record) => record.id === 'inbox-demo')).toMatchObject({
      status: 'loaded',
      kind: 'client+server',
    })
    error.mockRestore()
  })

  it('lands a contribution in all three v1 areas', async () => {
    await loadRuntimePlugin(source, 'inbox-demo', 'client+server')

    for (const area of [AREAS.routes, AREAS.sidebarNav, AREAS.statusbarRight]) {
      expect(contributionIn(area), `nothing contributed to ${area}`).toBeDefined()
    }
  })

  it('claims a route path and a nav destination that agree with each other', async () => {
    await loadRuntimePlugin(source, 'inbox-demo', 'client+server')

    const page = contributions.getArea(AREAS.routes).find((entry) => entry.source === 'plugin:inbox-demo')
    const nav = contributions.getArea(AREAS.sidebarNav).find((entry) => entry.source === 'plugin:inbox-demo')

    expect((page?.data as { path?: string }).path).toBe('/inbox-demo')
    expect((nav?.data as { href?: string }).href).toBe('/inbox-demo')
  })

  it('namespaces its local contribution ids under the plugin', async () => {
    await loadRuntimePlugin(source, 'inbox-demo', 'client+server')

    expect(contributionIn(AREAS.routes)?.id).toBe('inbox-demo:page')
  })

  it('takes every contribution down again on unload', async () => {
    await loadRuntimePlugin(source, 'inbox-demo', 'client+server')
    unloadRuntimePlugin('inbox-demo')

    for (const area of [AREAS.routes, AREAS.sidebarNav, AREAS.statusbarRight]) {
      expect(contributionIn(area)).toBeUndefined()
    }
  })
})
