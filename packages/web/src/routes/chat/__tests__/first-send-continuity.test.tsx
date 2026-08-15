import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

// The real route, the real pane, the real transcript. A stub of any of the
// three would keep this suite green with the fix reverted, which is the one
// thing it exists to prevent: the whole bug lives in how the page keys the
// pane and how the pane gates the transcript.

/** One record per ChatPane instance: how many WS subscriptions it opened and closed. */
const probes = vi.hoisted(() => ({ panes: [] as { subs: number; unsubs: number }[] }))

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ id: 's-new', status: 'running' })),
  getSession: vi.fn(async (id: string) => ({ id, status: 'running', engine: 'claude', model: 'opus', messages: [] })),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(async () => ({ sessions: [], counts: {}, perGroup: {} })),
  getOrg: vi.fn(async () => ({ employees: [] })),
  getEngines: vi.fn(async () => ({ engines: {} })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  // QueuePanel spreads this; an object here throws inside the error boundary.
  getSessionQueue: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
  uploadFile: vi.fn(async () => ({ id: 'f1' })),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

vi.mock('@/hooks/use-gateway', async () => {
  // Stable identity: ChatPane threads this straight into useLiveSession, and a
  // fresh function per render would resubscribe on every commit.
  const subscribe = () => () => {}
  const gateway = { events: [], connected: true, connectionSeq: 0, skillsVersion: 0, subscribe }
  return { useGateway: () => gateway }
})

// The real hook, instrumented. ChatPane is its only caller, so one record here
// is one pane subtree: a remount that threw the transcript away shows up as a
// second record, and the WS subscription the key exists to protect is counted
// per pane rather than stubbed away.
vi.mock('@/hooks/use-live-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-live-session')>()
  const { useCallback, useState } = await import('react')
  return {
    ...actual,
    useLiveSession: (sessionId: string | null, opts: Parameters<typeof actual.useLiveSession>[1]) => {
      const [record] = useState(() => {
        const fresh = { subs: 0, unsubs: 0 }
        probes.panes.push(fresh)
        return fresh
      })
      const subscribe = useCallback((listener: Parameters<typeof opts.subscribe>[0]) => {
        record.subs += 1
        const off = opts.subscribe(listener)
        return () => { record.unsubs += 1; off() }
      }, [opts.subscribe, record])
      return actual.useLiveSession(sessionId, { ...opts, subscribe })
    },
  }
})

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/chat/chat-sidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
  pickDeleteFallbackId: () => null,
}))

import ChatPageWrapper from '../page'

let navigate: ReturnType<typeof useNavigate>

function RouterProbe() {
  navigate = useNavigate()
  const location = useLocation()
  return <div data-testid="loc">{location.pathname + location.search}</div>
}

function renderChatRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <RouterProbe />
        <Routes>
          <Route path="/" element={<ChatPageWrapper />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const transcript = () => document.querySelector('.chat-messages-scroll')
const spinner = () => screen.queryByRole('status', { name: 'Loading chat' })

/** Every commit, not just the ones the test happens to look at. */
function watchForBlanking(node: Element) {
  const seen = { transcriptDetached: false, spinner: false }
  const observer = new MutationObserver(() => {
    if (!node.isConnected) seen.transcriptDetached = true
    if (document.querySelector('[role="status"][aria-label="Loading chat"]')) seen.spinner = true
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return { seen, stop: () => observer.disconnect() }
}

async function typeFirstMessage(text: string) {
  const textarea = await screen.findByPlaceholderText('Type a message...')
  fireEvent.change(textarea, { target: { value: text } })
  return textarea
}

describe('the real chat route across a first send', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    probes.panes.length = 0
    apiMocks.createSession.mockClear()
  })

  it('keeps the pane, the transcript and the user bubble as the session id arrives', async () => {
    renderChatRoute()
    const textarea = await typeFirstMessage('first message')

    // Captured on a blank composer, before anything has been sent.
    const transcriptBefore = transcript()
    expect(transcriptBefore).toBeTruthy()
    expect(probes.panes).toHaveLength(1)
    expect(spinner()).toBeNull()
    const watch = watchForBlanking(transcriptBefore!)

    await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false }) })

    // The optimistic bubble is painted while the session is still id-less.
    const bubbleBefore = await screen.findByText('first message')
    expect(apiMocks.createSession).toHaveBeenCalledWith({ source: 'web', prompt: 'first message' })

    // The id has landed in the URL: same conversation, same subtree, same nodes.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/?session=s-new'))
    watch.stop()

    expect(screen.queryByText('Chat crashed')).toBeNull()
    expect(transcript()).toBe(transcriptBefore)
    expect(screen.getByText('first message')).toBe(bubbleBefore)
    expect(probes.panes).toHaveLength(1)
    expect(watch.seen.transcriptDetached).toBe(false)
    expect(watch.seen.spinner).toBe(false)
    expect(spinner()).toBeNull()
  })

  it('still remounts on a real session switch, unsubscribing the old pane exactly once', async () => {
    renderChatRoute()
    const textarea = await typeFirstMessage('first message')
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false }) })
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/?session=s-new'))

    const transcriptBefore = transcript()
    expect(probes.panes).toHaveLength(1)
    const [first] = probes.panes
    expect(first.subs - first.unsubs).toBe(1)

    await act(async () => { void navigate('/?session=s-other') })
    await waitFor(() => expect(probes.panes).toHaveLength(2))

    // The old pane closed every subscription it opened, exactly once each — a
    // double teardown would push unsubs past subs, a leak would leave it short.
    expect(first.unsubs).toBe(first.subs)
    // And the new pane holds the only live one: no stacking, which is the whole
    // reason the key survives a genuine session switch.
    const [, second] = probes.panes
    expect(second.subs - second.unsubs).toBe(1)
    expect(transcript()).not.toBe(transcriptBefore)
  })
})
