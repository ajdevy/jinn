import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'

/**
 * What the reader opened stays open.
 *
 * A windowed transcript unmounts the rows the reader scrolls past, so anything
 * a row remembered in its own `useState` — an expanded tool group, a user paste
 * they clicked "Show more" on — would quietly close itself every time it left
 * the window. Both live on the transcript now, keyed by message id.
 */

const ROW_H = 120
const VIEWPORT_H = 700
const LONG_PASTE = 'a very long pasted question\n'.repeat(20)

const thread: Message[] = [
  ...Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: `filler ${i}`,
    timestamp: 1_700_000_000_000 + i * 1000,
  })),
  { id: 'u-long', role: 'user', content: LONG_PASTE, timestamp: 1_700_000_300_000 },
  ...['read_file', 'write_file', 'run_tests'].map((tool, i) => ({
    id: `t${i}`,
    role: 'assistant' as const,
    content: `Used ${tool}`,
    toolCall: tool,
    timestamp: 1_700_000_301_000 + i * 1000,
  })),
]

/** The user bubble collapses on its own rendered height, which jsdom has none of. */
function stubBubbleHeight() {
  return vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const inLongPaste = this.parentElement?.classList.contains('user-msg-bubble')
      && this.closest('[data-message-id="u-long"]') !== null
    return inLongPaste ? 600 : 0
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('expansion across the virtual window', () => {
  it('keeps a tool group and a user paste open after they scroll out and back', () => {
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    const heightStub = stubBubbleHeight()
    render(<ChatMessages messages={thread} loading={false} />)
    act(() => { layout.scrollToBottom() })

    // The transcript is windowed and mounts the bottom of the thread.
    expect(layout.mountedMessageIds().length).toBeLessThan(thread.length / 4)
    expect(layout.mountedMessageIds()).toContain('t0')

    act(() => { fireEvent.click(screen.getByRole('button', { name: /3 tools/ })) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Show more' })) })
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()

    // Read all the way up: both rows unmount.
    act(() => { layout.scrollTo(0) })
    expect(layout.mountedMessageIds()).not.toContain('t0')
    expect(layout.mountedMessageIds()).not.toContain('u-long')
    expect(screen.queryByTestId('tool-group-list')).toBeNull()

    // …and back down.
    act(() => { layout.scrollToBottom() })
    expect(layout.mountedMessageIds()).toContain('t0')
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()

    heightStub.mockRestore()
    layout.release()
  })
})
