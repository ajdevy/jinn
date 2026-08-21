import { useEffect, useMemo, useState } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatTouchOrder } from './use-chat-touch-order'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  /** `undefined` until the sessions query resolves, which is distinct from a
   *  gateway that genuinely has no sessions — the touch order must not prune
   *  itself against a list that has not arrived. */
  sessions: ReadonlyArray<{ id?: unknown }> | undefined
}) {
  const viewport = useChatViewport()
  const touchOrder = useChatTouchOrder(committedId, sessions)
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
  const reservedComposerSlots = !viewport.mobile && !committedId && workingSet.sessionIds.length > 0 ? 1 : 0
  const visibleWorkingSet = useMemo(() => overflowForViewport({
    ...workingSet,
    sessionIds: gridSessionIds,
    focusedId: focusedSessionId,
  }, viewport.width, viewport.height, reservedComposerSlots).visible, [focusedSessionId, gridSessionIds, reservedComposerSlots, viewport.height, viewport.width, workingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleWorkingSet.sessionIds
  const initialMobileSessionIds = useMemo(
    () => mobileWorkingSetIds(visibleWorkingSet.sessionIds, sessions ?? [], [], focusedSessionId, touchOrder),
    [focusedSessionId, sessions, touchOrder, visibleWorkingSet.sessionIds],
  )
  const [mobileSessionIds, setMobileSessionIds] = useState(initialMobileSessionIds)
  useEffect(() => {
    setMobileSessionIds((current) => {
      const next = mobileWorkingSetIds(visibleWorkingSet.sessionIds, sessions ?? [], current, focusedSessionId, touchOrder)
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next
    })
  }, [focusedSessionId, sessions, touchOrder, visibleWorkingSet.sessionIds])
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, mobileSessionIds }
}
