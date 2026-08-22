import { describe, expect, it } from 'vitest'
import { workingSetIndexForGridSlot } from '../grid-drop-target'
import { createWorkingSet, insertWorkingSetSession } from '../working-set'

function insertedOrder(
  sessionIds: string[],
  domSlot: number,
  paneKeys: string[],
  options: { committedSessionId: string | null; focusedId?: string; pickerPaneKey?: string | null },
): string[] {
  const workingSet = createWorkingSet(sessionIds, options.focusedId ?? sessionIds[0] ?? null)
  const index = workingSetIndexForGridSlot(domSlot, {
    workingSet,
    paneKeys,
    primaryPaneKey: 'primary',
    committedSessionId: options.committedSessionId,
    pickerPaneKey: options.pickerPaneKey,
  })
  return insertWorkingSetSession(workingSet, 'x', index, 20).sessionIds
}

describe('workingSetIndexForGridSlot', () => {
  it('translates a committed primary pane through its substituted working-set member', () => {
    expect(insertedOrder(['a', 'b', 'c'], 2, ['a', 'primary', 'c'], {
      committedSessionId: 'b',
      focusedId: 'b',
    })).toEqual(['a', 'b', 'x', 'c'])
  })

  it('appends beside a session-less primary pane', () => {
    expect(insertedOrder(['a', 'b'], 2, ['a', 'b', 'primary'], {
      committedSessionId: null,
    })).toEqual(['a', 'b', 'x'])
  })

  it('skips the mounted picker pane', () => {
    expect(insertedOrder(['a', 'b'], 2, ['primary', 'b', 'picker'], {
      committedSessionId: 'a',
      pickerPaneKey: 'picker',
    })).toEqual(['a', 'b', 'x'])
  })

  it('translates through folded overflow members before the right-hand anchor', () => {
    expect(insertedOrder(['a', 'b', 'c', 'd', 'e'], 1, ['primary', 'c', 'e'], {
      committedSessionId: 'a',
    })).toEqual(['a', 'b', 'x', 'c', 'd', 'e'])
  })

  it('covers end and empty-grid insertion', () => {
    expect(insertedOrder(['a', 'b', 'c', 'd', 'e'], 3, ['primary', 'c', 'e'], {
      committedSessionId: 'a',
    })).toEqual(['a', 'b', 'c', 'd', 'e', 'x'])
    expect(insertedOrder([], 0, [], { committedSessionId: null })).toEqual(['x'])
  })
})
