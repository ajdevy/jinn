/**
 * A child session that starts while no pane for it is mounted must not leave a
 * snapshot behind that predates the run: the next visitor (the thread peek)
 * seeds from that snapshot, reads its `idle` status, and paints a finished
 * delegation over a child that is very much still working.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { waitFor } from '@testing-library/react'
// The harness owns the `@/lib/api` mock, so it has to evaluate before anything
// that reaches for the api module — `use-live-session` included.
import { emit, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'
import {
  __clearLiveSessionSnapshotCacheForTests,
  prefetchLiveSessionSnapshot,
  readPrefetchedLiveSessionSnapshot,
} from '@/hooks/use-live-session'

const UNMOUNTED_CHILD = 'child-unmounted'

describe('live session snapshot invalidation', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    __clearLiveSessionSnapshotCacheForTests()
  })

  it('drops the cached snapshot of a session that starts while no pane holds it', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(gateway.listeners.size).toBeGreaterThan(0))

    await prefetchLiveSessionSnapshot(UNMOUNTED_CHILD)
    expect(readPrefetchedLiveSessionSnapshot(UNMOUNTED_CHILD)?.session?.status).toBe('idle')

    emit('session:started', { sessionId: UNMOUNTED_CHILD })

    expect(readPrefetchedLiveSessionSnapshot(UNMOUNTED_CHILD)).toBeNull()
  })
})
