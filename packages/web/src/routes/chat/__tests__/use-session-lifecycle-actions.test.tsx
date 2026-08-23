import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useSessionLifecycleActions } from '../use-session-lifecycle-actions'

const mutation = vi.hoisted(() => ({ mutateAsync: vi.fn() }))

vi.mock('@/hooks/use-sessions', () => ({
  useDeleteSession: () => mutation,
  useArchiveSession: () => mutation,
  useUnarchiveSession: () => mutation,
}))

describe('useSessionLifecycleActions', () => {
  it('keeps action identities stable when its options literal is rebuilt', () => {
    const client = new QueryClient()
    const values = {
      selectedIdRef: { current: 'a' },
      pendingNavRef: { current: undefined },
      sidebarOrderRef: { current: { sessionIds: ['a'], employeeNames: [], employeeSessionMap: {} } },
      sessionRows: [{ id: 'a' }],
      tabs: { closeTabBySessionId: vi.fn() },
      navigate: vi.fn(),
      selectSession: vi.fn(),
      removePane: vi.fn(),
      setMenuOpen: vi.fn(),
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      () => useSessionLifecycleActions({ ...values, tabs: { ...values.tabs } }),
      { wrapper },
    )
    const first = result.current

    rerender()

    expect(result.current.deleteSession).toBe(first.deleteSession)
    expect(result.current.archiveSession).toBe(first.archiveSession)
    expect(result.current.unarchiveSession).toBe(first.unarchiveSession)
  })
})
