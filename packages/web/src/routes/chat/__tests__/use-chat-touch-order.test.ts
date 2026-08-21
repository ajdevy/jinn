import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { TOUCH_ORDER_STORAGE_KEY } from '../touch-order'
import { useChatTouchOrder } from '../use-chat-touch-order'

const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'closed' }]

beforeEach(() => {
  localStorage.clear()
})

describe('useChatTouchOrder', () => {
  it('records every chat the operator commits into view, newest first', () => {
    const { result, rerender } = renderHook(
      ({ committedId }) => useChatTouchOrder(committedId, sessions),
      { initialProps: { committedId: 'a' as string | null } },
    )

    expect(result.current).toEqual(['a'])

    rerender({ committedId: 'b' })
    expect(result.current).toEqual(['b', 'a'])

    // Back to a chat already in the log moves it, it does not duplicate it.
    rerender({ committedId: 'a' })
    expect(result.current).toEqual(['a', 'b'])
  })

  it('restores the log across a reload and drops chats that no longer exist', () => {
    localStorage.setItem(
      TOUCH_ORDER_STORAGE_KEY,
      JSON.stringify({ version: 1, sessionIds: ['b', 'closed', 'a'] }),
    )

    const { result } = renderHook(() => useChatTouchOrder('a', sessions.slice(0, 2)))

    expect(result.current).toEqual(['a', 'b'])
  })

  it('starts empty rather than throwing on a corrupt stored log', () => {
    localStorage.setItem(TOUCH_ORDER_STORAGE_KEY, 'not json at all')

    const { result } = renderHook(() => useChatTouchOrder(null, sessions))

    expect(result.current).toEqual([])
  })
})
