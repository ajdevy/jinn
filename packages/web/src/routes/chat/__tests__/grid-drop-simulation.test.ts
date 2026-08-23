import { describe, expect, it } from 'vitest'
import { simulateChatGridDrop } from '../chat-grid-drop'
import { createWorkingSet } from '../working-set'

describe('simulateChatGridDrop', () => {
  it('predicts an unchanged pane count when an existing member moves', () => {
    const projection = simulateChatGridDrop('a', 2, ['primary', 'b', 'c'], {
      workingSet: createWorkingSet(['a', 'b', 'c'], 'a'),
      cap: 4,
      primaryPaneKey: 'primary',
      committedSessionId: 'a',
      pickerPaneKey: null,
      viewport: { width: 1440, height: 900 },
    })

    expect(projection.nextWorkingSet.sessionIds).toHaveLength(3)
    expect(projection.gridPaneKeys).toHaveLength(3)
  })

  it('predicts the future primary key when a regular session selection changes', () => {
    const projection = simulateChatGridDrop('c', 2, ['a', 'b'], {
      workingSet: createWorkingSet(['a', 'b'], 'b'),
      cap: 4,
      primaryPaneKey: 'b',
      committedSessionId: 'b',
      pickerPaneKey: null,
      viewport: { width: 1440, height: 900 },
    })

    expect(projection.nextWorkingSet.sessionIds).toEqual(['a', 'b', 'c'])
    expect(projection.gridPaneKeys).toEqual(['a', 'b', 'c'])
    expect(projection.droppedPaneIndex).toBe(2)
  })
})
