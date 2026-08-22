import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createWorkingSet } from '../working-set'
import { TOUCH_ORDER_STORAGE_KEY } from '../touch-order'
import { useChatTouchOrder } from '../use-chat-touch-order'
import { useChatGridState } from '../use-chat-grid-state'

const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'closed' }]

beforeEach(() => {
  localStorage.clear()
})

describe('useChatTouchOrder', () => {
  it('records every chat the operator commits into view, newest first', () => {
    const { result, rerender } = renderHook(
      ({ committedId }) => useChatTouchOrder(committedId, sessions, null),
      { initialProps: { committedId: 'a' as string | null } },
    )

    expect(result.current.ids).toEqual(['a'])

    rerender({ committedId: 'b' })
    expect(result.current.ids).toEqual(['b', 'a'])

    // Back to a chat already in the log moves it, it does not duplicate it.
    rerender({ committedId: 'a' })
    expect(result.current.ids).toEqual(['a', 'b'])
  })

  it('ignores a chat the route primed until the operator opens it themselves', () => {
    // handleSessionsLoaded commits the newest session so the thread has
    // something to show. Nobody asked for it, so it is not a touch — until the
    // operator taps that same chat, which clears the mark.
    const { result, rerender } = renderHook(
      ({ systemPrimedId }) => useChatTouchOrder('newest', sessions, systemPrimedId),
      { initialProps: { systemPrimedId: 'newest' as string | null } },
    )

    expect(result.current.ids).toEqual([])
    expect(result.current.hydrated).toBe(true)

    rerender({ systemPrimedId: null })
    expect(result.current.ids).toEqual(['newest'])
  })

  it('restores the log across a reload and drops chats that no longer exist', () => {
    localStorage.setItem(
      TOUCH_ORDER_STORAGE_KEY,
      JSON.stringify({ version: 1, sessionIds: ['b', 'closed', 'a'] }),
    )

    const { result } = renderHook(() => useChatTouchOrder('a', sessions.slice(0, 2), null))

    expect(result.current.ids).toEqual(['a', 'b'])
  })

  it('reports itself unhydrated until the sessions it prunes against arrive', () => {
    const { result, rerender } = renderHook(
      ({ live }) => useChatTouchOrder('a', live, null),
      { initialProps: { live: undefined as typeof sessions | undefined } },
    )

    expect(result.current).toEqual({ ids: [], hydrated: false })

    rerender({ live: sessions })
    expect(result.current.hydrated).toBe(true)
  })

  it('starts empty rather than throwing on a corrupt stored log', () => {
    localStorage.setItem(TOUCH_ORDER_STORAGE_KEY, 'not json at all')

    const { result } = renderHook(() => useChatTouchOrder(null, sessions, null))

    expect(result.current.ids).toEqual([])
  })
})

describe('mobile slots across a reload', () => {
  it('seats the persisted touched chats over ones with newer gateway activity', () => {
    localStorage.setItem(TOUCH_ORDER_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['topic-06', 'topic-08', 'topic-12', 'topic-11'],
    }))
    // Gateway last-activity order: never-opened topic-07 leads because an agent
    // has just written to it, and it must not take a slot on the way back in.
    const live = ['topic-07', 'topic-06', 'topic-12', 'topic-11', 'topic-08'].map((id) => ({ id }))

    const { result } = renderHook(() => useChatGridState({
      committedId: 'topic-06',
      workingSet: createWorkingSet(['topic-06'], 'topic-06'),
      sessions: live,
      systemPrimedId: null,
    }))

    expect(result.current.mobileSessionIds).toEqual(['topic-06', 'topic-08', 'topic-12', 'topic-11'])
  })
})
