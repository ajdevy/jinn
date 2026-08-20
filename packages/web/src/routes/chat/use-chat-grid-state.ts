import { useMemo } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  sessions: ReadonlyArray<{ id?: unknown }>
}) {
  const viewport = useChatViewport()
  // A URL selection can commit one render before working-set reconciliation.
  // Replace the primary member synchronously so both identities never mount.
  const gridSessionIds = useMemo(() => {
    if (!committedId || workingSet.sessionIds.includes(committedId)) return workingSet.sessionIds
    if (workingSet.focusedId && workingSet.sessionIds.includes(workingSet.focusedId)) {
      return workingSet.sessionIds.map((id) => id === workingSet.focusedId ? committedId : id)
    }
    return [...workingSet.sessionIds, committedId]
  }, [committedId, workingSet.focusedId, workingSet.sessionIds])
  const focusedSessionId = committedId
    ? (!workingSet.sessionIds.includes(committedId) ? committedId : workingSet.focusedId ?? committedId)
    : null
  const visibleWorkingSet = useMemo(() => overflowForViewport({
    ...workingSet,
    sessionIds: gridSessionIds,
    focusedId: focusedSessionId,
  }, viewport.width, viewport.height).visible, [focusedSessionId, gridSessionIds, viewport.height, viewport.width, workingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleWorkingSet.sessionIds
  const mobileSessionIds = useMemo(
    () => mobileWorkingSetIds(visibleWorkingSet.sessionIds, sessions),
    [sessions, visibleWorkingSet.sessionIds],
  )
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, mobileSessionIds }
}
