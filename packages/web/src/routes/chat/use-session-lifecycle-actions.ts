import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { SidebarOrder } from '@/components/chat/chat-sidebar-types'
import { pickDeleteFallbackId } from '@/components/chat/session-delete-fallback'
import { useArchiveSession, useDeleteSession, useUnarchiveSession } from '@/hooks/use-sessions'
import type { useChatTabs } from '@/hooks/use-chat-tabs'
import { clearIntermediateMessages } from '@/lib/conversations'
import { queryKeys } from '@/lib/query-keys'

type SelectSession = (id: string, options?: { replace?: boolean; navigateMobile?: boolean }) => void
type Tabs = Pick<ReturnType<typeof useChatTabs>, 'closeTabBySessionId'>

interface LifecycleOptions {
  selectedIdRef: RefObject<string | null>
  pendingNavRef: RefObject<string | null | undefined>
  sidebarOrderRef: RefObject<SidebarOrder>
  sessionRows: Array<{ id?: unknown }> | undefined
  tabs: Tabs
  navigate: NavigateFunction
  selectSession: SelectSession
  /** Drops the pane; a replacement id takes the departing pane's slot. */
  removePane: (sessionId: string, replacementId?: string | null) => void
  setMenuOpen: Dispatch<SetStateAction<boolean>>
}

function useDeleteAction({ selectedIdRef, pendingNavRef, removePane, setMenuOpen, selectSession, navigate }: LifecycleOptions, closeTab: (id: string) => void, fallbackFor: (id: string) => string | null) {
  const mutation = useDeleteSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    const wasActive = selectedIdRef.current === id
    const fallback = wasActive ? fallbackFor(id) : null
    if (wasActive) pendingNavRef.current = fallback
    try { await mutation.mutateAsync(id) } catch { /* it may already be gone */ }
    clearIntermediateMessages(id)
    // Hand the fallback to the working set with the removal: dropping the pane
    // first advances focus to a sibling, and the fallback navigation would then
    // replace THAT pane instead of the one being deleted.
    removePane(id, fallback)
    closeTab(id)
    setMenuOpen(false)
    if (wasActive && fallback) selectSession(fallback, { replace: true, navigateMobile: false })
    else if (wasActive) {
      pendingNavRef.current = null
      void navigate('/', { replace: true })
    }
    void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [closeTab, fallbackFor, mutation, navigate, pendingNavRef, qc, removePane, selectSession, selectedIdRef, setMenuOpen])
}

function useArchiveAction({ selectedIdRef, pendingNavRef, removePane, setMenuOpen, selectSession, navigate }: LifecycleOptions, closeTab: (id: string) => void, fallbackFor: (id: string) => string | null) {
  const mutation = useArchiveSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    const wasActive = selectedIdRef.current === id
    const fallback = wasActive ? fallbackFor(id) : null
    if (wasActive) pendingNavRef.current = fallback
    try { await mutation.mutateAsync(id) } catch {
      if (wasActive) pendingNavRef.current = undefined
      return
    }
    removePane(id, fallback)
    closeTab(id)
    setMenuOpen(false)
    if (wasActive && fallback) selectSession(fallback, { replace: true, navigateMobile: false })
    else if (wasActive) {
      pendingNavRef.current = null
      void navigate('/', { replace: true })
    }
    void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [closeTab, fallbackFor, mutation, navigate, pendingNavRef, qc, removePane, selectSession, selectedIdRef, setMenuOpen])
}

function useUnarchiveAction({ setMenuOpen }: LifecycleOptions) {
  const mutation = useUnarchiveSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    try {
      await mutation.mutateAsync(id)
      setMenuOpen(false)
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    } catch { /* retain archived state until the gateway confirms restoration */ }
  }, [mutation, qc, setMenuOpen])
}

export function useSessionLifecycleActions(options: LifecycleOptions) {
  const closeTabBySessionId = options.tabs.closeTabBySessionId
  const closeTab = useCallback((id: string) => {
    closeTabBySessionId(id)
  }, [closeTabBySessionId])
  const fallbackFor = useCallback((id: string) => pickDeleteFallbackId(
    options.sidebarOrderRef.current.sessionIds,
    (options.sessionRows ?? []).map((session) => String(session.id ?? '')),
    id,
  ), [options.sessionRows, options.sidebarOrderRef])
  const deleteSession = useDeleteAction(options, closeTab, fallbackFor)
  const archiveSession = useArchiveAction(options, closeTab, fallbackFor)
  const unarchiveSession = useUnarchiveAction(options)
  return { deleteSession, archiveSession, unarchiveSession }
}
