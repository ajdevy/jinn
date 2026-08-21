import { useEffect, useMemo, useState } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
  pickerOpen = false,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  sessions: ReadonlyArray<{ id?: unknown }>
  pickerOpen?: boolean
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
  const reservedPaneSlots = !viewport.mobile
    ? Number(!committedId && workingSet.sessionIds.length > 0) + Number(pickerOpen)
    : 0
  const visibleWorkingSet = useMemo(() => overflowForViewport({
    ...workingSet,
    sessionIds: gridSessionIds,
    focusedId: focusedSessionId,
  }, viewport.width, viewport.height, reservedPaneSlots).visible, [focusedSessionId, gridSessionIds, reservedPaneSlots, viewport.height, viewport.width, workingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleWorkingSet.sessionIds
  const initialMobileSessionIds = useMemo(
    () => mobileWorkingSetIds(visibleWorkingSet.sessionIds, sessions, [], focusedSessionId),
    [focusedSessionId, sessions, visibleWorkingSet.sessionIds],
  )
  const [mobileSessionIds, setMobileSessionIds] = useState(initialMobileSessionIds)
  useEffect(() => {
    setMobileSessionIds((current) => {
      const next = mobileWorkingSetIds(visibleWorkingSet.sessionIds, sessions, current, focusedSessionId)
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next
    })
  }, [focusedSessionId, sessions, visibleWorkingSet.sessionIds])
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, mobileSessionIds }
}
