import { describe, expect, it } from 'vitest'
import {
  TOUCH_ORDER_LIMIT,
  loadPersistedTouchOrder,
  persistTouchOrder,
  pruneTouchOrder,
  recordTouchedSession,
  restoreTouchOrder,
} from '../touch-order'

describe('chat touch order', () => {
  it('records the newest touch at the head without duplicating an earlier one', () => {
    const opened = recordTouchedSession(recordTouchedSession(['b'], 'a'), 'c')

    expect(opened).toEqual(['c', 'a', 'b'])
    expect(recordTouchedSession(opened, 'b')).toEqual(['b', 'c', 'a'])
  })

  it('returns the same log for a re-touch of the chat already at the head', () => {
    const opened = recordTouchedSession(['a', 'b'], 'a')

    expect(opened).toEqual(['a', 'b'])
  })

  it('ignores a blank session id', () => {
    expect(recordTouchedSession(['a'], '   ')).toEqual(['a'])
  })

  it('caps the log at the limit, dropping the least recently touched', () => {
    const ids = Array.from({ length: TOUCH_ORDER_LIMIT + 3 }, (_, index) => `s${index}`)
    const log = ids.reduce<string[]>((current, id) => recordTouchedSession(current, id), [])

    expect(log).toHaveLength(TOUCH_ORDER_LIMIT)
    expect(log[0]).toBe(ids.at(-1))
    expect(log).not.toContain('s0')
  })

  it('prunes ids whose sessions no longer exist', () => {
    expect(pruneTouchOrder(['a', 'gone', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('survives a reload through storage', () => {
    localStorage.clear()
    persistTouchOrder(localStorage, ['a', 'b'])

    expect(loadPersistedTouchOrder(localStorage, new Set(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('reads an absent or corrupt stored log as an empty log instead of throwing', () => {
    const live = new Set(['a'])

    expect(restoreTouchOrder(null, live)).toEqual([])
    expect(restoreTouchOrder('{not json', live)).toEqual([])
    expect(restoreTouchOrder('{"version":99,"sessionIds":["a"]}', live)).toEqual([])
    expect(restoreTouchOrder('{"version":1,"sessionIds":"a"}', live)).toEqual([])
  })

  it('survives a storage that throws on every access', () => {
    const hostile = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
    }

    expect(() => persistTouchOrder(hostile, ['a'])).not.toThrow()
    expect(loadPersistedTouchOrder(hostile, new Set(['a']))).toEqual([])
  })
})
