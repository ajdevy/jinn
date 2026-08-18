import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Behavior of the refactored chat list (title-first rows):
//  • Pinned folds behind "N more pinned" past PINNED_VISIBLE
//  • Scheduled is one link-row to /cron, never per-session rows
//  • automated/delegated sessions never flood the recency buckets — All mode
//    reveals them as per-employee Team groups instead

const sidebarData = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  counts: {} as Record<string, number>,
  pins: new Set<string>(),
}))

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: sidebarData.sessions, isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: sidebarData.counts, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: vi.fn() }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: sidebarData.pins }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getOrg: () => Promise.resolve({ employees: [] }),
    getEmployee: () => Promise.resolve({}),
  },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Jinn', employeeOverrides: {} } }),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

import { MemoryRouter } from 'react-router-dom'
import { ChatSidebar, PINNED_VISIBLE } from '../chat-sidebar'

const NOW = new Date().toISOString()

function webSession(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, source: 'web', lastActivity: NOW, ...extra }
}

function renderSidebar() {
  return render(withQueryClient(
    <MemoryRouter>
      <ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} />
    </MemoryRouter>,
  ))
}

beforeEach(() => {
  localStorage.clear()
  sidebarData.sessions = []
  sidebarData.counts = {}
  sidebarData.pins = new Set()
})

describe('pinned section cap', () => {
  it('folds pins beyond PINNED_VISIBLE behind "N more pinned" and expands on demand', () => {
    const total = PINNED_VISIBLE + 3
    sidebarData.sessions = Array.from({ length: total }, (_, i) =>
      webSession(`pin-${i}`, `Pinned chat ${i}`))
    sidebarData.pins = new Set(sidebarData.sessions.map((s) => s.id as string))

    renderSidebar()
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(PINNED_VISIBLE)

    const more = screen.getByRole('button', { name: '3 more pinned' })
    fireEvent.click(more)
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(total)
    expect(screen.getByRole('button', { name: 'Show fewer pinned' })).toBeTruthy()
  })

  it('shows every pin without a fold row at or below the cap', () => {
    sidebarData.sessions = Array.from({ length: PINNED_VISIBLE }, (_, i) =>
      webSession(`pin-${i}`, `Pinned chat ${i}`))
    sidebarData.pins = new Set(sidebarData.sessions.map((s) => s.id as string))

    renderSidebar()
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(PINNED_VISIBLE)
    expect(screen.queryByText(/more pinned/)).toBeNull()
  })
})

describe('scheduled link-row', () => {
  it('renders cron sessions as one link to /cron, not as list rows', () => {
    sidebarData.sessions = [
      webSession('chat-1', 'My own chat'),
      { id: 'cron-1', title: 'Nightly digest', source: 'cron', sourceRef: 'cron:digest', lastActivity: NOW },
    ]
    sidebarData.counts = { __cron__: 1345 }

    renderSidebar()
    expect(screen.queryByText('Nightly digest')).toBeNull()
    const link = screen.getByRole('link', { name: /Scheduled runs · 1,345/ })
    expect(link.getAttribute('href')).toBe('/cron')
  })

  it('still floats a pinned cron session into Pinned', () => {
    sidebarData.sessions = [
      { id: 'cron-1', title: 'Nightly digest', source: 'cron', sourceRef: 'cron:digest', lastActivity: NOW },
    ]
    sidebarData.pins = new Set(['cron-1'])

    renderSidebar()
    expect(screen.getByText('Nightly digest')).toBeTruthy()
    expect(screen.getByText('Pinned')).toBeTruthy()
  })
})

describe('automated sessions and the Team directory', () => {
  const OWN = webSession('own-1', 'Talk Orb Refinement')
  const CHILD = webSession('child-1', 'IMPLEMENT PHASE — round 1', {
    employee: 'jinn-dev',
    parentSessionId: 'own-1',
  })

  it('keeps delegated children out of Today in BOTH focus modes', () => {
    sidebarData.sessions = [OWN, CHILD]

    renderSidebar()
    // Default mode is All; the child renders only inside the Team group,
    // never as a flat Today row (Today count would read 2 otherwise).
    expect(screen.getByText('Talk Orb Refinement')).toBeTruthy()
    expect(screen.queryByText('IMPLEMENT PHASE — round 1')).toBeNull()
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.getByText('Jinn Dev')).toBeTruthy()
  })

  it('hides the Team directory in Focused mode', () => {
    localStorage.setItem('jinn-sidebar-focus-mode', 'focused')
    sidebarData.sessions = [OWN, CHILD]

    renderSidebar()
    expect(screen.getByText('Talk Orb Refinement')).toBeTruthy()
    expect(screen.queryByText('Jinn Dev')).toBeNull()
  })

  it('keeps workflow runs as first-class rows in the recency buckets', () => {
    localStorage.setItem('jinn-sidebar-focus-mode', 'focused')
    sidebarData.sessions = [
      OWN,
      { id: 'wf-1', title: 'Nightly digest run', source: 'workflow', sourceRef: 'wfrun:x', employee: 'jinn-dev', lastActivity: NOW },
    ]

    renderSidebar()
    expect(screen.getByText('Nightly digest run')).toBeTruthy()
  })

  it('expands an employee group to its sessions on click', () => {
    sidebarData.sessions = [
      OWN,
      CHILD,
      webSession('child-2', 'PLAN PHASE — planning only', { employee: 'jinn-dev', parentSessionId: 'own-1' }),
    ]

    renderSidebar()
    fireEvent.click(screen.getByText('Jinn Dev'))
    expect(screen.getByText('IMPLEMENT PHASE — round 1')).toBeTruthy()
    expect(screen.getByText('PLAN PHASE — planning only')).toBeTruthy()
  })
})
