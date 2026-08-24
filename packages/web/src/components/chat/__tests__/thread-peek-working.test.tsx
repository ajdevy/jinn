import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'
import { api } from '@/lib/api'
import { __clearLiveSessionSnapshotCacheForTests } from '@/hooks/use-live-session'
import { ThreadPeek, type CommsPeekData } from '../thread-peek'

const { subscribe, emit, resetBus } = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  const subscribe = vi.fn((fn: GatewayEventListener) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  })
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners) listener({ event, payload } as GatewayEvent)
  }
  const resetBus = () => {
    listeners.clear()
    subscribe.mockClear()
  }
  return { subscribe, emit, resetBus }
})

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn() },
}))

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe,
  }),
}))

const getSession = vi.mocked(api.getSession)

const SESSION_ID = 'child-live'

function dispatchedAt(): number {
  return Date.now() - 5 * 60_000
}

function workingPeek(overrides: Partial<CommsPeekData> = {}): CommsPeekData {
  return {
    kind: 'delegation',
    employee: 'design-lead',
    displayName: 'Design Lead',
    sessionId: SESSION_ID,
    messageId: 'delegation-1',
    timestamp: dispatchedAt(),
    preview: 'Inspect the layout',
    ...overrides,
  }
}

function replyPeek(overrides: Partial<CommsPeekData> = {}): CommsPeekData {
  return {
    kind: 'reply',
    employee: 'design-lead',
    displayName: 'Design Lead',
    sessionId: SESSION_ID,
    messageId: 'reply-1',
    timestamp: dispatchedAt(),
    preview: 'Canvas direction is ready.',
    ...overrides,
  }
}

function renderPeek(peek: CommsPeekData | null) {
  const onClose = vi.fn()
  const onOpenFullChat = vi.fn()
  const view = render(
    <ThreadPeek
      peek={peek}
      onClose={onClose}
      onOpenFullChat={onOpenFullChat}
      renderContent={(text) => text}
    />,
  )
  return { ...view, onClose, onOpenFullChat }
}

beforeEach(() => {
  resetBus()
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe('thread peek working state', () => {
  it('shows a pulsing working state line with elapsed minutes, not a checkmark', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    renderPeek(workingPeek())

    await waitFor(() => {
      expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
    })
    expect(document.querySelector('[data-state-line="replied"]')).toBeNull()
    expect(screen.getByText(/Working · 5m/)).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')?.innerHTML).toContain('jinn-pulse')
  })

  it('re-renders live tool and text activity without reopening', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    renderPeek(workingPeek())
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    expect(screen.getByText('Starting up')).toBeTruthy()

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'tool_use', toolName: 'Bash' })
    })
    expect(screen.getByText(/Using Bash/)).toBeTruthy()
    expect(screen.queryByText('Starting up')).toBeNull()

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'text', content: 'Found the layout file.' })
    })
    expect(screen.getByText(/Found the layout file/)).toBeTruthy()
    expect(screen.getByText(/Using Bash/)).toBeTruthy()
  })

  it('renders a settled reply as the full final message with the replied state line', async () => {
    const fullReply = 'Canvas direction is ready.\n\nKeep left-in/right-out port discipline.'
    getSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'idle',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: fullReply },
      ],
    })
    renderPeek(replyPeek({
      preview: 'Canvas direction is ready. Keep left-in/right-out port discipline.',
    }))

    await waitFor(() => {
      expect(screen.getByText(/Keep left-in\/right-out port discipline/)).toBeTruthy()
    })
    expect(document.querySelector('[data-state-line="replied"]')).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')).toBeNull()
    expect(screen.getByText(/Replied ·/)).toBeTruthy()
  })

  it('says Starting up when a working session has produced nothing yet', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'waiting', messages: [] })
    renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('Starting up')).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
  })

  it('stays read-only with the same footer, open-full-chat, Escape, and scrim close', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    const first = renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('Read-only')).toBeTruthy()
    expect(document.querySelector('[data-testid="thread-peek"] textarea')).toBeNull()
    expect(document.querySelector('[data-testid="thread-peek"] input')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
    expect(first.onOpenFullChat).toHaveBeenCalledWith(SESSION_ID)

    fireEvent.click(screen.getByLabelText('Close preview'))
    expect(first.onClose).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second.onClose).toHaveBeenCalledTimes(1)
  })

  it('does not open a live subscription while the peek is closed', () => {
    renderPeek(null)
    expect(subscribe).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
  })
})
