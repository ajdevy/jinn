import { describe, expect, it } from 'vitest'
import { focusWorkingSetSession, createWorkingSet } from '../working-set'
import {
  capForViewport,
  layoutFor,
  overflowForViewport,
} from '../grid-layout'

describe('chat grid layout', () => {
  it('lays one pane out without grid chrome and four panes as a 2x2 desktop grid', () => {
    expect(layoutFor(1, 1440, 900)).toEqual({ columns: 1, rows: 1 })
    expect(layoutFor(2, 1440, 900)).toEqual({ columns: 2, rows: 1 })
    expect(layoutFor(3, 1440, 900)).toEqual({ columns: 2, rows: 2 })
    expect(layoutFor(4, 1440, 900)).toEqual({ columns: 2, rows: 2 })
  })

  it('holds four panes at the 1440x900 desktop floor', () => {
    expect(capForViewport(1440, 900)).toBeGreaterThanOrEqual(4)
  })

  it('grows on an ultrawide and shrinks again around 1100px', () => {
    const ultrawide = capForViewport(2560, 1440)
    const narrow = capForViewport(1100, 900)

    expect(ultrawide).toBeGreaterThan(4)
    expect(narrow).toBeLessThan(ultrawide)
    expect(narrow).toBe(4)
  })

  it('never falls below the four-pane desktop floor', () => {
    expect(capForViewport(1024, 640)).toBe(4)
  })

  it('folds least-recently-focused members without folding the focused pane', () => {
    let state = createWorkingSet(['a', 'b', 'c', 'd', 'e', 'f'], 'f')
    state = focusWorkingSetSession(state, 'b')

    const overflow = overflowForViewport(state, 1100, 900)

    expect(overflow.visible.sessionIds).toEqual(['b', 'd', 'e', 'f'])
    expect(overflow.visible.focusedId).toBe('b')
    expect(overflow.foldedIds).toEqual(['a', 'c'])
  })

  it('reserves a capped pane for the composer without mutating the stored set', () => {
    const state = createWorkingSet(['a', 'b', 'c', 'd'], 'a')

    const composing = overflowForViewport(state, 1440, 900, 1)

    expect(capForViewport(1440, 900)).toBe(4)
    expect(composing.visible.sessionIds).toHaveLength(3)
    expect(composing.foldedIds).toHaveLength(1)
    expect(state.sessionIds).toEqual(['a', 'b', 'c', 'd'])
    expect(overflowForViewport(state, 1440, 900).visible.sessionIds).toEqual(state.sessionIds)
  })
})
