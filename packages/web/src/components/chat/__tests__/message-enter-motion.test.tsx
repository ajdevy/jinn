import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { reconcileMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

function user(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'user', content, timestamp: T0, ...extra }
}

function assistant(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: T0 + 1_000 }
}

const bubbles = (container: HTMLElement) => container.querySelectorAll('.user-msg-bubble')
const entering = (container: HTMLElement) => container.querySelectorAll('[data-msg-enter]')

describe('enter attribute — live arrivals only', () => {
  it('marks a user bubble whose id was absent at mount', () => {
    const { container, rerender } = render(<ChatMessages messages={[user('u1', 'first')]} loading={false} />)
    expect(entering(container)).toHaveLength(0)

    rerender(<ChatMessages messages={[user('u1', 'first'), user('u2', 'second')]} loading={false} />)
    const marked = container.querySelectorAll('.user-msg-bubble[data-msg-enter]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('second')
  })

  it('never marks a message present at mount, so a session switch does not replay history', () => {
    const history = [user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')]
    const { container } = render(<ChatMessages messages={history} loading={false} />)
    expect(entering(container)).toHaveLength(0)
  })
})

describe('stream-preceded swaps do not animate', () => {
  it('leaves the row that replaces the streaming bubble unmarked', () => {
    const messages = [user('u1', 'ask')]
    const { container, rerender } = render(
      <ChatMessages messages={messages} loading streamingText="" />,
    )
    rerender(<ChatMessages messages={messages} loading streamingText="partial ans" />)
    rerender(<ChatMessages messages={[...messages, assistant('a1', 'partial answer')]} loading={false} streamingText="" />)

    expect(container.querySelectorAll('.assistant-transcript[data-msg-enter]')).toHaveLength(0)
  })

  it('marks a reply that arrived with no stream before it', () => {
    const messages = [user('u1', 'ask')]
    const { container, rerender } = render(<ChatMessages messages={messages} loading={false} streamingText="" />)
    rerender(<ChatMessages messages={[...messages, assistant('a1', 'answer')]} loading={false} streamingText="" />)

    const marked = container.querySelectorAll('.assistant-transcript[data-msg-enter]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('answer')
  })

  it('does not let a stopped stream silence the next reply', () => {
    const messages = [user('u1', 'ask')]
    const { container, rerender } = render(<ChatMessages messages={messages} loading streamingText="" />)
    rerender(<ChatMessages messages={messages} loading streamingText="partial" />)
    // Stop: the stream is discarded without ever committing a final row.
    rerender(<ChatMessages messages={messages} loading={false} streamingText="" />)
    rerender(<ChatMessages messages={[...messages, assistant('a1', 'answer')]} loading={false} streamingText="" />)

    const marked = container.querySelectorAll('.assistant-transcript[data-msg-enter]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('answer')
  })
})

describe('reconcile does not re-animate or duplicate', () => {
  it('keeps the optimistic id, the single row, and the attribute it already had', () => {
    const optimistic = user('client-uuid', 'hello')
    const { container, rerender } = render(<ChatMessages messages={[]} loading={false} />)
    rerender(<ChatMessages messages={[optimistic]} loading={false} />)

    const before = container.querySelector('.user-msg-bubble')!
    expect(before.getAttribute('data-msg-enter')).toBe('true')

    // The server twin lands with its own canonical id; reconcile adopts the
    // content and keeps the local id so the React key never changes.
    const merged = reconcileMessages([optimistic], [{ ...optimistic, id: 'server-id' }])
    expect(merged.map((m) => m.id)).toEqual(['client-uuid'])
    rerender(<ChatMessages messages={merged} loading={false} />)

    expect(bubbles(container)).toHaveLength(1)
    const after = container.querySelector('.user-msg-bubble')!
    expect(after).toBe(before)
    expect(after.getAttribute('data-msg-enter')).toBe('true')
  })
})

describe('failed send', () => {
  it('shows the failure on the bubble that failed, with a retry', () => {
    const failed = user('u1', 'hello', { sendState: 'failed', sendError: 'Failed to fetch' })
    const { container } = render(<ChatMessages messages={[failed]} loading={false} onRetry={vi.fn()} />)

    expect(container.querySelector('.user-msg-bubble')!.getAttribute('data-send-state')).toBe('failed')
    expect(screen.getByText('Not delivered')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('carries the transport error without putting it in the copy', () => {
    const failed = user('u1', 'hello', { sendState: 'failed', sendError: 'Failed to fetch' })
    const { container } = render(<ChatMessages messages={[failed]} loading={false} onRetry={vi.fn()} />)

    const row = container.querySelector('.send-failure-row')!
    expect(row.getAttribute('title')).toBe('Failed to fetch')
    expect(row.textContent).not.toContain('Failed to fetch')
  })

  it('sends the failed message text back down the ordinary send path on Retry', () => {
    const onRetry = vi.fn()
    const failed = user('u1', 'hello', { sendState: 'failed' })
    render(<ChatMessages messages={[failed]} loading={false} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('hello', undefined)
  })

  it('resends what was sent, not what the bubble displays', () => {
    const onRetry = vi.fn()
    const sent = 'verify http://127.0.0.1:7790/retry.png'
    const failed = user('u1', sent, { sendState: 'failed' })
    render(<ChatMessages messages={[failed]} loading={false} onRetry={onRetry} />)

    // The bubble strips the url to render a thumbnail, so display text is 'verify'.
    // Retrying that would send a different message and strand the failed row, which
    // the send path supersedes by content.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith(sent, undefined)
  })

  it('keeps Retry live for an attachment-only failure and carries its media', () => {
    const onRetry = vi.fn()
    const media = [{ type: 'image' as const, url: 'blob:local', name: 'shot.png' }]
    const failed = user('u1', '', { sendState: 'failed', media })
    render(<ChatMessages messages={[failed]} loading={false} onRetry={onRetry} />)

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledWith('', media)
  })

  it('renders no failure row for a pending or settled message', () => {
    const { container } = render(
      <ChatMessages messages={[user('u1', 'a', { sendState: 'pending' }), user('u2', 'b')]} loading={false} />,
    )
    expect(container.querySelector('.send-failure-row')).toBeNull()
    expect(container.querySelectorAll('.user-msg-bubble')[0].getAttribute('data-send-state')).toBe('pending')
    expect(container.querySelectorAll('.user-msg-bubble')[1].getAttribute('data-send-state')).toBeNull()
  })
})
