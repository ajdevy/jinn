import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import ChatPageWrapper from '../page'
import { CHAT_SESSION_DND_MIME } from '../chat-session-dnd'

const { sessionIds } = vi.hoisted(() => ({ sessionIds: ['a', 'b', 'c', 'd'] }))
const gateway = vi.hoisted(() => ({
  listeners: new Set<(frame: { event: string; payload: unknown }) => void>(),
}))
const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (id: string) => ({
    id,
    title: `Title ${id}`,
    status: 'idle',
    engine: 'claude',
    messages: [{ id: `${id}-m1`, role: 'assistant', content: `transcript-${id}`, timestamp: 1 }],
  })),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(async () => ({
    sessions: sessionIds.map((id) => ({ id, title: `Title ${id}`, status: 'idle' })),
    counts: {},
    perGroup: {},
  })),
  getPins: vi.fn(async () => ({ pins: [] })),
  searchSessions: vi.fn(async (query: string) => sessionIds
    .filter((id) => `Title ${id}`.toLowerCase().includes(query.toLowerCase()))
    .map((id) => ({ id, title: `Title ${id}`, status: 'idle' }))),
  getOrg: vi.fn(async () => ({ employees: [] })),
  getEngines: vi.fn(async () => ({ engines: {} })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 'e' })),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
  deleteSession: vi.fn(async () => ({})),
  duplicateSession: vi.fn(async (id: string) => ({ id: `${id}-copy`, title: `Copy of ${id}` })),
  archiveSession: vi.fn(async () => ({})),
  unarchiveSession: vi.fn(async () => ({})),
  stopSession: vi.fn(async () => ({})),
  pinChat: vi.fn(async () => ({})),
  unpinChat: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe: (listener: (frame: { event: string; payload: unknown }) => void) => {
      gateway.listeners.add(listener)
      return () => gateway.listeners.delete(listener)
    },
  }),
}))

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/chat/chat-sidebar', () => ({
  ChatSidebar: ({ onNewChat, onOrderComputed }: { onNewChat: () => void; onOrderComputed?: (order: unknown) => void }) => {
    useEffect(() => onOrderComputed?.({ sessionIds, employeeNames: [], employeeSessionMap: {} }), [onOrderComputed])
    return <div data-testid="chat-sidebar"><button type="button" onClick={onNewChat}>Start empty chat</button></div>
  },
  pickDeleteFallbackId: () => null,
}))

vi.mock('@/hooks/use-chat-tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-tabs')>()
  const tabs = sessionIds.map((sessionId) => ({
    kind: 'session' as const,
    sessionId,
    label: sessionId,
    status: 'idle' as const,
    unread: false,
  }))
  const noop = () => {}
  return {
    ...actual,
    useChatTabs: () => ({
      tabs,
      activeTab: tabs[0],
      activeIndex: 0,
      hydrated: true,
      openTab: noop,
      openFileTab: noop,
      closeTab: noop,
      switchTab: noop,
      nextTab: noop,
      prevTab: noop,
      pinTab: noop,
      moveTab: noop,
      clearActiveTab: noop,
      updateTabStatus: noop,
      closeTabBySessionId: noop,
      reconcileTabs: noop,
    }),
  }
})

export function pane(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-chat-pane-session="${id}"]`)
  if (!node) throw new Error(`missing pane ${id}`)
  return node
}

export function emit(event: string, payload: unknown) {
  act(() => gateway.listeners.forEach((listener) => listener({ event, payload })))
}

function BackProbe() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(-1)}>Test browser back</button>
}

export function renderRoute(initialEntry = '/?session=a'): { unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <BackProbe />
        <Routes><Route path="/" element={<ChatPageWrapper />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

export function sessionTransfer(sessionId: string): DataTransfer {
  return {
    types: [CHAT_SESSION_DND_MIME],
    files: [] as unknown as FileList,
    effectAllowed: 'copy',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: (type: string) => type === CHAT_SESSION_DND_MIME ? sessionId : '',
  } as unknown as DataTransfer
}

export { apiMocks, gateway, sessionIds }
