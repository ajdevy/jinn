import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { ChatPane } from '../chat-pane'
import { usePaneIdentity } from '@/routes/chat/pane-identity'
import type { Message } from '@/lib/conversations'

// Two halves of one guarantee. The page decides whether the pane subtree
// survives a first send (its key), and the pane decides whether the transcript
// survives hydration (its gate). Either one alone still blanks the chat.

const userMessage: Message = { id: 'm-first', role: 'user', content: 'first message', timestamp: 0 }

// ─── Half one: the page's keying decision ───────────────────────────────────

const unsubscribe = vi.fn()
let mounts = 0

/** Stands in for ChatPane: holds the optimistic bubble locally, as beginSend does. */
function StubPane({ sessionId, pendingUserMessage, onSessionCreated }: {
  sessionId: string | null
  pendingUserMessage?: Message
  onSessionCreated?: (sessionId: string, pending?: Message) => void
}) {
  const [messages, setMessages] = useState<Message[]>(pendingUserMessage ? [pendingUserMessage] : [])
  // The WS subscription lives and dies with the subtree — the reason the key exists.
  useEffect(() => {
    mounts += 1
    return unsubscribe
  }, [])
  return (
    <div data-testid="transcript" data-session={sessionId ?? 'new'}>
      {messages.map((message) => (
        <div key={message.id} data-testid={`bubble-${message.role}`}>{message.content}</div>
      ))}
      {/* Two commits, as in the real pane: beginSend paints the bubble while the
          session is still id-less, and createSession resolves a tick later. */}
      <button type="button" onClick={() => setMessages([userMessage])}>send</button>
      <button type="button" onClick={() => onSessionCreated?.('s-new', userMessage)}>created</button>
    </div>
  )
}

/** The keying half of routes/chat/page.tsx, with nothing else from the route. */
function ChatRoute() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { paneKey, pendingMessage, adoptSession } = usePaneIdentity(selectedId, null)
  // Mirrors handleSessionCreated: the adoption is urgent, the navigation is a
  // transition. That ordering is the race — the URL lands a frame late.
  const onSessionCreated = useCallback((id: string, pending?: Message) => {
    adoptSession(id, pending)
    startTransition(() => setSelectedId(id))
  }, [adoptSession])
  return (
    <>
      <button type="button" onClick={() => startTransition(() => setSelectedId('s-other'))}>switch</button>
      <StubPane
        key={paneKey}
        sessionId={selectedId}
        pendingUserMessage={pendingMessage}
        onSessionCreated={onSessionCreated}
      />
    </>
  )
}

describe('the chat page across a first send', () => {
  beforeEach(() => {
    mounts = 0
    unsubscribe.mockReset()
  })

  function firstSend() {
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'send' })) })
    const nodes = { transcript: screen.getByTestId('transcript'), bubble: screen.getByTestId('bubble-user') }
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'created' })) })
    return nodes
  }

  it('keeps the pane, the transcript and the user bubble as the session id arrives', () => {
    render(<ChatRoute />)
    expect(screen.getByTestId('transcript').dataset.session).toBe('new')
    expect(mounts).toBe(1)

    const before = firstSend()

    // The id has landed: same conversation, same subtree, same nodes.
    expect(screen.getByTestId('transcript').dataset.session).toBe('s-new')
    expect(screen.getByTestId('transcript')).toBe(before.transcript)
    expect(screen.getByTestId('bubble-user')).toBe(before.bubble)
    expect(screen.getByTestId('bubble-user').textContent).toBe('first message')
    expect(mounts).toBe(1)
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('still remounts on a real session switch, unsubscribing the old pane exactly once', () => {
    render(<ChatRoute />)
    const before = firstSend()
    expect(mounts).toBe(1)

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'switch' })) })

    expect(mounts).toBe(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('transcript')).not.toBe(before.transcript)
  })
})

// ─── Half two: the pane's hydration gate ────────────────────────────────────

interface LiveSessionMockState {
  messages: Message[]
  streamingText: string
  loading: boolean
  hydrating: boolean
  session: Record<string, unknown> | null
  error: Error | null
  liveContextTokens: number | null
  backgroundActivity: unknown
  reload: ReturnType<typeof vi.fn>
  beginSend: ReturnType<typeof vi.fn>
  failSend: ReturnType<typeof vi.fn>
  appendLocal: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

let liveSessionState: LiveSessionMockState

function liveSession(overrides: Partial<LiveSessionMockState> = {}): LiveSessionMockState {
  return {
    messages: [],
    streamingText: '',
    loading: false,
    hydrating: false,
    session: { id: 's-new', status: 'running', engine: 'claude', model: 'opus' },
    error: null,
    liveContextTokens: null,
    backgroundActivity: null,
    reload: vi.fn(),
    beginSend: vi.fn(),
    failSend: vi.fn(),
    appendLocal: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  }
}

// Query data is hoisted, not rebuilt per render: react-query hands back a stable
// reference, and a fresh object here re-fires the pane's effects forever.
const orgData = { employees: [] }
const featuresData = { notesEnabled: false, staleChat: { enabled: false } }

vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => liveSessionState }))
vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(() => Promise.resolve({})) } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => ({ data: orgData }) }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => ({ data: featuresData, isPending: false }) }))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ messages }: { messages: Message[] }) => (
    <div data-testid="messages">
      {messages.map((message) => (
        <div key={message.id} data-testid={`row-${message.role}`}>{message.content}</div>
      ))}
    </div>
  ),
}))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/queue-panel', () => ({ QueuePanel: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))

const subscribe = () => () => {}
const events: [] = []
const spinner = () => screen.queryByRole('status', { name: 'Loading chat' })

function renderPane(sessionId: string | null) {
  return render(
    <ChatPane sessionId={sessionId} isActive onFocus={() => {}} subscribe={subscribe} events={events} />,
  )
}

describe('ChatPane while the session id lands', () => {
  afterEach(() => { vi.useRealTimers() })

  it('never unmounts the transcript or shows a spinner across the send', () => {
    liveSessionState = liveSession({ messages: [userMessage], loading: true, session: null })
    const { rerender } = renderPane(null)
    const messagesBefore = screen.getByTestId('messages')
    const rowBefore = screen.getByTestId('row-user')
    expect(spinner()).toBeNull()

    // The id arrives on a pane that was never re-keyed, so props move alone.
    liveSessionState = liveSession({ messages: [userMessage], loading: true })
    rerender(
      <ChatPane sessionId="s-new" isActive onFocus={() => {}} subscribe={subscribe} events={events} />,
    )

    expect(screen.getByTestId('messages')).toBe(messagesBefore)
    expect(screen.getByTestId('row-user')).toBe(rowBefore)
    expect(spinner()).toBeNull()
  })

  it('holds the spinner for 250ms on a cold open, transcript mounted throughout', () => {
    vi.useFakeTimers()
    liveSessionState = liveSession({ hydrating: true, session: null })
    renderPane('cold')

    const messagesNode = screen.getByTestId('messages')
    expect(spinner()).toBeNull()

    act(() => { vi.advanceTimersByTime(249) })
    expect(spinner()).toBeNull()

    act(() => { vi.advanceTimersByTime(1) })
    expect(spinner()).toBeTruthy()
    // The point of the threshold: the spinner arrives over the transcript, not instead of it.
    expect(screen.getByTestId('messages')).toBe(messagesNode)
  })
})
