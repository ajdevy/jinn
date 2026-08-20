import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

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
  getOrg: vi.fn(async () => ({ employees: [] })),
  getEngines: vi.fn(async () => ({ engines: {} })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
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
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
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

import ChatPageWrapper from '../page'
import { WORKING_SET_STORAGE_KEY } from '../working-set'

function pane(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-chat-pane-session="${id}"]`)
  if (!node) throw new Error(`missing pane ${id}`)
  return node
}

function emit(event: string, payload: unknown) {
  act(() => gateway.listeners.forEach((listener) => listener({ event, payload })))
}

describe('the routed multi-pane surface', () => {
  beforeEach(() => {
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.sendMessage.mockClear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
  })

  it('keeps four live transcripts isolated and preserves a streaming pane while a sibling closes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/?session=a']}>
          <Routes><Route path="/" element={<ChatPageWrapper />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    await waitFor(() => sessionIds.forEach((id) => expect(pane(id).textContent).toContain(`transcript-${id}`)))

    fireEvent.click(pane('c'))
    await waitFor(() => expect(pane('c').getAttribute('data-chat-pane-active')).toBe('true'))
    await waitFor(() => expect(screen.getAllByText('Title c').length).toBeGreaterThan(0))

    const untouched = new Map(['a', 'b', 'd'].map((id) => [id, pane(id).textContent]))
    const textarea = pane('c').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'only-c-grows' } })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledWith('c', expect.objectContaining({ message: 'only-c-grows' })))
    expect(document.activeElement).toBe(textarea)
    for (const [id, text] of untouched) expect(pane(id).textContent).toBe(text)
    expect(pane('c').textContent?.match(/only-c-grows/g)).toHaveLength(1)

    const foregroundBeforeBackground = pane('c').textContent
    emit('session:delta', { sessionId: 'b', type: 'text', content: 'background-b' })
    await waitFor(() => expect(pane('b').textContent).toContain('background-b'))
    expect(pane('c').textContent).toBe(foregroundBeforeBackground)
    expect(pane('a').textContent).toBe(untouched.get('a'))
    expect(pane('d').textContent).toBe(untouched.get('d'))

    emit('session:delta', { sessionId: 'c', type: 'text', content: 'stream-c' })
    await waitFor(() => expect(pane('c').textContent).toContain('stream-c'))
    const streamingPane = screen.getByTestId('pane-c')
    const streamingText = pane('c').textContent

    fireEvent.click(screen.getByRole('button', { name: 'Close b' }))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="b"]')).toBeNull())
    expect(screen.getByTestId('pane-c')).toBe(streamingPane)
    expect(pane('c').textContent).toBe(streamingText)
    expect(pane('a').textContent).toContain('transcript-a')
    expect(pane('d').textContent).toContain('transcript-d')
  })
})
