import { describe, expect, it } from 'vitest'
import {
  clearMobileWorkingSetMoved,
  mobileWorkingSetIds,
  reduceMobileWorkingSetActivity,
  type MobileWorkingSetActivity,
} from '../mobile-working-set-activity'

describe('mobile working-set activity', () => {
  it('fills four fixed slots without changing existing presentation order', () => {
    const sessions = [
      { id: 'd' },
      { id: 'c' },
      { id: 'b' },
      { id: 'a' },
      { id: 'e' },
    ]

    expect(mobileWorkingSetIds(['a', 'c'], sessions)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('cross-fades once per message while appending streamed chunks without duplication', () => {
    const initial: Record<string, MobileWorkingSetActivity> = {}
    const first = reduceMobileWorkingSetActivity(initial, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text', content: 'work' },
    })
    const second = reduceMobileWorkingSetActivity(first, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text', content: 'ing' },
    })
    const snapshot = reduceMobileWorkingSetActivity(second, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text_snapshot', content: 'working safely' },
    })

    expect(first.b).toMatchObject({ preview: 'Work', revision: 1, moved: true, receivingText: true })
    expect(second.b).toMatchObject({ preview: 'Working', revision: 1, moved: true, receivingText: true })
    expect(snapshot.b).toMatchObject({ preview: 'Working safely', revision: 1, moved: true })
  })

  it('starts a new revision for complete messages, ignores outsiders, and clears moved on focus', () => {
    const initial: Record<string, MobileWorkingSetActivity> = {}
    const ignored = reduceMobileWorkingSetActivity(initial, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'outside', type: 'text', content: 'nope' },
    })
    const notified = reduceMobileWorkingSetActivity(ignored, ['a', 'b'], 'a', {
      event: 'session:notification',
      payload: { sessionId: 'b', content: 'background finished' },
    })

    expect(ignored).toBe(initial)
    expect(notified.b).toMatchObject({ preview: 'Background finished', revision: 1, moved: true, receivingText: false })
    expect(clearMobileWorkingSetMoved(notified, 'b').b.moved).toBe(false)
  })
})
