import { useCallback, useEffect, useState } from 'react'
import { readViewMode, writeViewMode, type ViewMode } from '@/lib/view-mode'

export interface SessionMeta {
  sessionId: string
  engine?: string
  engineSessionId?: string
  model?: string
  title?: string
  employee?: string
  archivedAt?: string | null
}

type MetaUpdate = Omit<SessionMeta, 'sessionId'>

function usePaneViewMode(committedId: string | null, focusedId: string | null) {
  const [newViewMode, setNewViewMode] = useState<ViewMode>('chat')
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>({})
  useEffect(() => {
    if (!committedId) return
    setViewModes((current) => current[committedId]
      ? current
      : { ...current, [committedId]: readViewMode(committedId) })
  }, [committedId])

  const viewModeFor = useCallback(
    (sessionId: string) => viewModes[sessionId] ?? readViewMode(sessionId),
    [viewModes],
  )
  const viewMode = focusedId ? viewModeFor(focusedId) : newViewMode
  const setViewModeFor = useCallback((sessionId: string | null, mode: ViewMode) => {
    if (!sessionId) {
      setNewViewMode(mode)
      return
    }
    setViewModes((current) => ({ ...current, [sessionId]: mode }))
    writeViewMode(sessionId, mode)
  }, [])
  const setViewMode = useCallback((mode: ViewMode) => setViewModeFor(focusedId, mode), [focusedId, setViewModeFor])
  return { viewMode, viewModeFor, setViewMode, setViewModeFor }
}

function usePaneFocus() {
  const [newFocusTrigger, setNewFocusTrigger] = useState(0)
  const [focusTriggers, setFocusTriggers] = useState<Record<string, number>>({})
  const bumpFocus = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      setNewFocusTrigger((current) => current + 1)
      return
    }
    setFocusTriggers((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }))
  }, [])
  const focusTriggerFor = useCallback(
    (sessionId: string | null) => sessionId ? focusTriggers[sessionId] ?? 0 : newFocusTrigger,
    [focusTriggers, newFocusTrigger],
  )
  return { bumpFocus, focusTriggerFor }
}

export function useChatPaneState(committedId: string | null, focusedId: string | null) {
  const [metaById, setMetaById] = useState<Record<string, SessionMeta>>({})
  const [newMeta, setNewMeta] = useState<SessionMeta | null>(null)
  const view = usePaneViewMode(committedId, focusedId)
  const focus = usePaneFocus()
  const meta = focusedId ? metaById[focusedId] ?? null : newMeta

  const updateMeta = useCallback((sessionId: string, update: MetaUpdate) => {
    setMetaById((current) => ({ ...current, [sessionId]: { sessionId, ...update } }))
  }, [])
  const updateNewMeta = useCallback((update: MetaUpdate) => {
    setNewMeta({ sessionId: 'new', ...update })
  }, [])

  return {
    meta,
    metaById,
    updateMeta,
    updateNewMeta,
    ...view,
    ...focus,
  }
}
