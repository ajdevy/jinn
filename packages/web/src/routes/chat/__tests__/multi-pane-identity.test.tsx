import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const getSession = vi.fn(async (id: string) => ({
  id,
  status: 'idle',
  messages: [{ id: `${id}-m1`, role: 'user', content: `${id} original`, timestamp: 1 }],
}))

vi.mock('@/lib/api', () => ({
  api: {
    getSession: (id: string) => getSession(id),
    getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  },
}))

import {
  __clearLiveSessionSnapshotCacheForTests,
  __getLiveSessionSnapshotCacheSizeForTests,
} from '@/hooks/use-live-session'
import {
  emitPaneEvent,
  MultiPaneSurface,
  resetPaneEvents,
} from './open-continuity-harness'

function paneState(id: string) {
  const pane = screen.getByTestId(`pane-${id}`)
  return {
    messages: pane.getAttribute('data-messages'),
    stream: pane.getAttribute('data-stream'),
  }
}

beforeEach(() => {
  getSession.mockClear()
  resetPaneEvents()
  __clearLiveSessionSnapshotCacheForTests()
})

describe('multiple live pane identities', () => {
  it('routes each session event only to the pane that owns that session', async () => {
    render(<MultiPaneSurface sessionIds={['a', 'b']} />)
    await waitFor(() => expect(paneState('a').messages).toContain('a original'))
    await waitFor(() => expect(paneState('b').messages).toContain('b original'))

    act(() => {
      emitPaneEvent({
        event: 'session:delta',
        payload: { sessionId: 'a', type: 'text', content: 'only-a' },
      })
    })

    expect(paneState('a').stream).toBe('only-a')
    expect(paneState('b').stream).toBe('')
  })

  it('keeps a streaming pane byte-identical when a sibling is removed', async () => {
    const { rerender } = render(<MultiPaneSurface sessionIds={['a', 'b']} />)
    await waitFor(() => expect(paneState('b').messages).toContain('b original'))
    act(() => {
      emitPaneEvent({
        event: 'session:delta',
        payload: { sessionId: 'b', type: 'text', content: 'still streaming' },
      })
    })
    const before = paneState('b')

    rerender(<MultiPaneSurface sessionIds={['b']} />)

    expect(paneState('b')).toEqual(before)
  })

  it('writes one distinct snapshot key per unique pane identity', async () => {
    render(<MultiPaneSurface sessionIds={['a', 'b']} />)
    await waitFor(() => expect(paneState('a').messages).toContain('a original'))
    await waitFor(() => expect(paneState('b').messages).toContain('b original'))
    await waitFor(() => expect(__getLiveSessionSnapshotCacheSizeForTests()).toBe(2))

    expect(getSession).toHaveBeenCalledTimes(2)
  })
})
