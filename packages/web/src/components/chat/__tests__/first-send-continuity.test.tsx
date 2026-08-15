import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ChatPane } from '../chat-pane'
import type { Message } from '@/lib/conversations'

// The pane's half of the guarantee: the transcript survives hydration. The
// page's half — that the subtree survives the first send at all — is driven
// through the real route in routes/chat/__tests__/first-send-continuity.
// Either one alone still blanks the chat.

const userMessage: Message = { id: 'm-first', role: 'user', content: 'first message', timestamp: 0 }

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
