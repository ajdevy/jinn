import { describe, expect, it, vi } from 'vitest'
import type { KVStore } from '@/lib/view-mode'
import { contributions } from '@/contrib/registry'
import { createPluginContext } from '../plugin-context'

// The registry is a singleton, so every test invents its own area id and
// disposes what it registered — a shared area would leak between tests exactly
// the way a stale registration leaks in production.
let areaCounter = 0
function freshArea(): string {
  areaCounter += 1
  return `plugin.context.area.${areaCounter}`
}

function fakeStore(seed?: Record<string, string>): KVStore {
  const entries = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

describe('contribution scoping', () => {
  it('namespaces a local id and stamps the plugin as the source', () => {
    const area = freshArea()
    const dispose = createPluginContext('cost-meter').contribute({ id: 'chip', area })

    expect(contributions.getArea(area)).toEqual([
      { id: 'cost-meter:chip', area, source: 'plugin:cost-meter' },
    ])

    dispose()
  })

  // A plugin that could write its own id into the contribution id would be able
  // to land an un-namespaced entry, or one inside another plugin's namespace.
  it.each([
    ['a bare local id', 'chip', 'cost-meter:chip'],
    ['another plugin’s id', 'inbox:chip', 'cost-meter:inbox:chip'],
    ['its own id spelled again', 'cost-meter:chip', 'cost-meter:cost-meter:chip'],
  ])('cannot escape its namespace with %s', (_label, local, expected) => {
    const area = freshArea()
    const dispose = createPluginContext('cost-meter').contribute({ id: local, area })

    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([expected])

    dispose()
  })

  it('scopes and stamps a batch the same way, under one disposer', () => {
    const area = freshArea()
    const dispose = createPluginContext('inbox').contributeMany([
      { id: 'one', area },
      { id: 'two', area },
    ])

    expect(contributions.getArea(area).map((entry) => [entry.id, entry.source])).toEqual([
      ['inbox:one', 'plugin:inbox'],
      ['inbox:two', 'plugin:inbox'],
    ])

    dispose()
    expect(contributions.getArea(area)).toEqual([])
  })

  it('exposes the source tag it stamps', () => {
    expect(createPluginContext('inbox').source).toBe('plugin:inbox')
  })
})

describe('disposal tracking', () => {
  it('hands every registration’s disposer to the tracker', () => {
    const area = freshArea()
    const tracked: (() => void)[] = []
    const ctx = createPluginContext('inbox', (dispose) => tracked.push(dispose))

    ctx.contribute({ id: 'one', area })
    ctx.contributeMany([{ id: 'two', area }])
    const own = vi.fn()
    ctx.onDispose(own)

    expect(tracked).toHaveLength(3)
    for (const dispose of tracked) dispose()

    expect(contributions.getArea(area)).toEqual([])
    expect(own).toHaveBeenCalledTimes(1)
  })

  it('still returns a working disposer when nothing is tracking', () => {
    const area = freshArea()
    const dispose = createPluginContext('inbox').contribute({ id: 'one', area })

    dispose()

    expect(contributions.getArea(area)).toEqual([])
  })
})

describe('plugin storage', () => {
  it('reads and writes under a key prefixed with the plugin id', () => {
    const store = fakeStore()

    createPluginContext('inbox', undefined, store).storage.set('draft', { body: 'hi' })

    expect(store.getItem('jinn.plugin.inbox.draft')).toBe('{"body":"hi"}')
  })

  it('round-trips a value', () => {
    const storage = createPluginContext('inbox', undefined, fakeStore()).storage

    storage.set('count', 3)

    expect(storage.get('count', 0)).toBe(3)
  })

  it('cannot read another plugin’s key', () => {
    const store = fakeStore({ 'jinn.plugin.inbox.secret': '"theirs"' })

    expect(createPluginContext('cost-meter', undefined, store).storage.get('secret', 'mine')).toBe(
      'mine',
    )
  })

  it.each([
    ['absent', undefined],
    ['unparseable', '{not json'],
  ])('falls back when the stored value is %s', (_label, stored) => {
    const store = fakeStore(stored === undefined ? {} : { 'jinn.plugin.inbox.k': stored })

    expect(createPluginContext('inbox', undefined, store).storage.get('k', 'fallback')).toBe(
      'fallback',
    )
  })

  it('degrades to the fallback when there is no store at all', () => {
    const storage = createPluginContext('inbox', undefined, null).storage

    expect(() => storage.set('k', 1)).not.toThrow()
    expect(storage.get('k', 'fallback')).toBe('fallback')
  })
})
