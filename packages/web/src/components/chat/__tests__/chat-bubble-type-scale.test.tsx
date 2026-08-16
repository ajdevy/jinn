import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

const conversation: Message[] = [
  { id: 'u1', role: 'user', content: 'ok', timestamp: T0 },
  { id: 'a1', role: 'assistant', content: 'Sure.', timestamp: T0 + 1_000 },
]

// Both bubbles sit on the Body step and take the leading that step binds. The
// relaxed override was tuned for the smaller subheadline size and reads loose here.
describe('message bubble type scale', () => {
  it('puts the user bubble on Body without the relaxed leading, keeping medium weight', () => {
    const { container } = render(<ChatMessages messages={conversation} loading={false} />)

    const bubble = container.querySelector('.user-msg-bubble')!
    expect(bubble.classList.contains('text-[length:var(--text-body)]')).toBe(true)
    expect(bubble.classList.contains('leading-[var(--leading-relaxed)]')).toBe(false)
    expect(bubble.classList.contains('font-[var(--weight-medium)]')).toBe(true)
  })

  it('keeps the assistant transcript on Body without the relaxed leading', () => {
    const { container } = render(<ChatMessages messages={conversation} loading={false} />)

    const transcript = container.querySelector('.assistant-transcript')!
    expect(transcript.classList.contains('text-[length:var(--text-body)]')).toBe(true)
    expect(transcript.classList.contains('leading-[var(--leading-relaxed)]')).toBe(false)
  })
})
