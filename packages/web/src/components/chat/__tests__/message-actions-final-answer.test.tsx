import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

/**
 * The copy / read-aloud / retry row belongs to the answer, not to every block
 * the model wrote on the way there. Interim prose is evidence the fold puts
 * away, so an action row on it is a second offer of the same turn — and the
 * reserved 26px band under it is the inset the reader sees stacking up.
 */
const MULTI_PROSE_TURN: Message[] = [
  { id: 'u1', role: 'user', content: 'Ship it.', timestamp: T0 },
  { id: 'a1', role: 'assistant', content: 'Looking into it.', timestamp: T0 + 1_000 },
  { id: 'a2', role: 'assistant', content: 'Shipped. Here is the summary.', timestamp: T0 + 2_000 },
]

function renderTranscript(messages: Message[], props: { loading?: boolean; streamingText?: string } = {}) {
  return render(
    <MemoryRouter>
      <ChatMessages messages={messages} loading={props.loading ?? false} streamingText={props.streamingText} />
    </MemoryRouter>,
  )
}

describe('assistant action row placement', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  it('renders one action row for a multi-prose turn, on the row that closes it', () => {
    const { container } = renderTranscript(MULTI_PROSE_TURN)

    const actions = container.querySelectorAll('.msg-actions')
    expect(actions).toHaveLength(1)
    expect(actions[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a2')
  })

  it('leaves an interim prose row without an action row or its reserved band', () => {
    const { container } = renderTranscript(MULTI_PROSE_TURN)

    const interim = container.querySelector('[data-message-id="a1"]')!
    expect(interim.textContent).toContain('Looking into it.')
    expect(interim.querySelector('.msg-actions')).toBeNull()
    expect(interim.querySelector('[data-message-actions-reserve]')).toBeNull()
    // The band is reserved height, not a collapsed one: prove the 26px box is
    // gone rather than merely transparent.
    expect(interim.querySelector('.h-\\[26px\\]')).toBeNull()
  })

  it('copies the closing answer in full', () => {
    renderTranscript(MULTI_PROSE_TURN)

    fireEvent.click(screen.getByLabelText('Copy message'))

    expect(writeText).toHaveBeenCalledWith('Shipped. Here is the summary.')
  })

  it('keeps the reserved band on the streaming row, which is the presumptive answer', () => {
    const { container } = renderTranscript([MULTI_PROSE_TURN[0]], { loading: true, streamingText: 'Ship' })

    const streaming = container.querySelector('[data-streaming]')!
    expect(streaming.querySelector('[data-message-actions-reserve]')).not.toBeNull()
  })
})
