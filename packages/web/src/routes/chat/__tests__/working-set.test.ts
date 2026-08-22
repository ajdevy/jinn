import { describe, expect, it } from 'vitest'
import {
  addWorkingSetSession,
  applyWorkingSetCap,
  createWorkingSet,
  focusWorkingSetSession,
  insertWorkingSetSession,
  loadPersistedWorkingSet,
  persistWorkingSet,
  replaceFocusedWorkingSetSession,
  removeWorkingSetSession,
  reorderWorkingSetSession,
  restoreWorkingSet,
  serializeWorkingSet,
} from '../working-set'

describe('chat working set', () => {
  it('focuses a duplicate add without duplicating or reordering it', () => {
    const initial = createWorkingSet(['a', 'b', 'c'], 'c')

    const next = addWorkingSetSession(initial, 'a', 4)

    expect(next.sessionIds).toEqual(['a', 'b', 'c'])
    expect(next.focusedId).toBe('a')
    expect(next.focusHistory).toEqual(['b', 'c', 'a'])
  })

  it('evicts the least-recently-focused member and preserves the focused pane', () => {
    let state = createWorkingSet(['a', 'b', 'c', 'd'], 'd')
    state = focusWorkingSetSession(state, 'b')

    const afterAdd = addWorkingSetSession(state, 'e', 4)
    const afterShrink = applyWorkingSetCap(afterAdd, 2)

    expect(afterAdd.sessionIds).toEqual(['b', 'c', 'd', 'e'])
    expect(afterAdd.focusedId).toBe('e')
    expect(afterShrink.sessionIds).toContain('e')
    expect(afterShrink.sessionIds).toEqual(['b', 'e'])
  })

  it('keeps presentation order independent from focus recency', () => {
    const initial = createWorkingSet(['a', 'b', 'c'], 'c')
    const focused = focusWorkingSetSession(initial, 'a')
    const reordered = reorderWorkingSetSession(focused, 'c', 0)

    expect(focused.sessionIds).toEqual(['a', 'b', 'c'])
    expect(focused.focusHistory).toEqual(['b', 'c', 'a'])
    expect(reordered.sessionIds).toEqual(['c', 'a', 'b'])
    expect(reordered.focusHistory).toEqual(['b', 'c', 'a'])
  })

  it('inserts a session at a clamped presentation slot and focuses it', () => {
    const initial = createWorkingSet(['a', 'b'], 'a')

    const prepended = insertWorkingSetSession(initial, 'before', -10, 4)
    const appended = insertWorkingSetSession(prepended, 'after', 99, 4)

    expect(prepended.sessionIds).toEqual(['before', 'a', 'b'])
    expect(appended.sessionIds).toEqual(['before', 'a', 'b', 'after'])
    expect(appended.focusedId).toBe('after')
    expect(appended.focusHistory.at(-1)).toBe('after')
  })

  it('moves an existing member through insertion slots without duplicating it', () => {
    const initial = createWorkingSet(['a', 'b', 'c'], 'c')

    const moved = insertWorkingSetSession(initial, 'a', 2, 4)

    expect(moved.sessionIds).toEqual(['b', 'a', 'c'])
    expect(moved.sessionIds.filter((id) => id === 'a')).toHaveLength(1)
    expect(moved.focusedId).toBe('a')
    expect(moved.focusHistory).toEqual(['b', 'c', 'a'])
  })

  it('keeps the inserted session when applying the working-set cap', () => {
    const initial = createWorkingSet(['a', 'b', 'c', 'd'], 'd')

    const next = insertWorkingSetSession(initial, 'new', 2, 4)

    expect(next.sessionIds).toEqual(['a', 'b', 'new', 'd'])
    expect(next.focusedId).toBe('new')
  })

  it('keeps the previewed insertion slot when a full grid evicts an older pane', () => {
    const initial = createWorkingSet(['a', 'b', 'c', 'd'], 'd')

    const next = insertWorkingSetSession(initial, 'new', 1, 4)

    expect(next.sessionIds).toEqual(['a', 'new', 'c', 'd'])
    expect(next.sessionIds[1]).toBe('new')
  })

  it('returns an empty working set when insertion capacity is zero', () => {
    const initial = createWorkingSet(['a', 'b'], 'b')

    expect(insertWorkingSetSession(initial, 'new', 1, 0)).toEqual(createWorkingSet())
  })

  it('ignores blank ids and non-integer insertion slots', () => {
    const initial = createWorkingSet(['a', 'b'], 'a')

    expect(insertWorkingSetSession(initial, '  ', 1, 4)).toBe(initial)
    expect(insertWorkingSetSession(initial, 'c', 1.5, 4)).toBe(initial)
  })

  it('chooses the most recently focused survivor when the focused pane is removed', () => {
    let state = createWorkingSet(['a', 'b', 'c'], 'c')
    state = focusWorkingSetSession(state, 'a')

    const next = removeWorkingSetSession(state, 'a')

    expect(next.sessionIds).toEqual(['b', 'c'])
    expect(next.focusedId).toBe('c')
    expect(next.focusHistory).toEqual(['b', 'c'])
  })

  it('replaces the focused slot for ordinary navigation without growing the grid', () => {
    let state = createWorkingSet(['a', 'b', 'c'], 'b')
    state = replaceFocusedWorkingSetSession(state, 'outside')

    expect(state.sessionIds).toEqual(['a', 'outside', 'c'])
    expect(state.focusedId).toBe('outside')
    expect(state.focusHistory.at(-1)).toBe('outside')
  })

  it('round-trips persistence and drops sessions that no longer exist', () => {
    let state = createWorkingSet(['live-a', 'dead', 'live-b'], 'dead')
    state = focusWorkingSetSession(state, 'live-a')
    const serialized = serializeWorkingSet(state)

    const restored = restoreWorkingSet(serialized, new Set(['live-a', 'live-b']), 4)

    expect(restored).toEqual({
      sessionIds: ['live-a', 'live-b'],
      focusedId: 'live-a',
      focusHistory: ['live-b', 'live-a'],
    })
  })

  it('persists through the browser storage boundary', () => {
    localStorage.clear()
    const state = createWorkingSet(['a', 'b'], 'a')

    persistWorkingSet(localStorage, state)

    expect(loadPersistedWorkingSet(localStorage, new Set(['a', 'b']), 4)).toEqual(state)
  })

  it('normalizes malformed persisted members instead of restoring duplicates', () => {
    const raw = JSON.stringify({
      version: 1,
      sessionIds: ['a', '', 'a', 42, 'b'],
      focusedId: 'missing',
      focusHistory: ['b', 'b', 'missing'],
    })

    expect(restoreWorkingSet(raw, new Set(['a', 'b']), 4)).toEqual({
      sessionIds: ['a', 'b'],
      focusedId: 'b',
      focusHistory: ['a', 'b'],
    })
    expect(restoreWorkingSet('{broken', new Set(['a']), 4)).toEqual(createWorkingSet())
  })
})
