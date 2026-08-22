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
  removePane: (sessionId: string) => void
  setMenuOpen: Dispatch<SetStateAction<boolean>>
}

function useDeleteAction(options: LifecycleOptions, closeTab: (id: string) => void, fallbackFor: (id: string) => string | null) {
  const mutation = useDeleteSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    const wasActive = options.selectedIdRef.current === id
    const fallback = wasActive ? fallbackFor(id) : null
    if (wasActive) options.pendingNavRef.current = fallback
    try { await mutation.mutateAsync(id) } catch { /* it may already be gone */ }
    clearIntermediateMessages(id)
    options.removePane(id)
    closeTab(id)
    options.setMenuOpen(false)
    if (wasActive && fallback) options.selectSession(fallback, { replace: true, navigateMobile: false })
    else if (wasActive) {
      options.pendingNavRef.current = null
      void options.navigate('/', { replace: true })
    }
    void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [closeTab, fallbackFor, mutation, options, qc])
}

function useArchiveAction(options: LifecycleOptions, closeTab: (id: string) => void, fallbackFor: (id: string) => string | null) {
  const mutation = useArchiveSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    const wasActive = options.selectedIdRef.current === id
    const fallback = wasActive ? fallbackFor(id) : null
    if (wasActive) options.pendingNavRef.current = fallback
    try { await mutation.mutateAsync(id) } catch {
      if (wasActive) options.pendingNavRef.current = undefined
      return
    }
    options.removePane(id)
    closeTab(id)
    options.setMenuOpen(false)
    if (wasActive && fallback) options.selectSession(fallback, { replace: true, navigateMobile: false })
    else if (wasActive) {
      options.pendingNavRef.current = null
      void options.navigate('/', { replace: true })
    }
    void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [closeTab, fallbackFor, mutation, options, qc])
}

function useUnarchiveAction(options: LifecycleOptions) {
  const mutation = useUnarchiveSession()
  const qc = useQueryClient()
  return useCallback(async (id: string) => {
    try {
      await mutation.mutateAsync(id)
      options.setMenuOpen(false)
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    } catch { /* retain archived state until the gateway confirms restoration */ }
  }, [mutation, options, qc])
}

export function useSessionLifecycleActions(options: LifecycleOptions) {
  const closeTab = useCallback((id: string) => {
    options.tabs.closeTabBySessionId(id)
  }, [options])
  const fallbackFor = useCallback((id: string) => pickDeleteFallbackId(
    options.sidebarOrderRef.current.sessionIds,
    (options.sessionRows ?? []).map((session) => String(session.id ?? '')),
    id,
  ), [options])
  const deleteSession = useDeleteAction(options, closeTab, fallbackFor)
  const archiveSession = useArchiveAction(options, closeTab, fallbackFor)
  const unarchiveSession = useUnarchiveAction(options)
  return { deleteSession, archiveSession, unarchiveSession }
}
