import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { commsArrivalDelayMs } from '../message-arrival'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

function user(id: string, content: string): Message {
  return { id, role: 'user', content, timestamp: T0 }
}

function assistant(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: T0 + 1_000 }
}

function replies(count: number, from: number): Message[] {
  return Array.from({ length: count }, (_, i) => assistant(`a${from + i}`, `reply ${from + i}`))
}

const entering = (container: HTMLElement) => container.querySelectorAll('[data-msg-enter]')

/** A tab that was backgrounded catches up in one loadSession commit. */
function arriveInOneCommit(newMessages: Message[]) {
  const history = [user('u1', 'ask')]
  const { container, rerender } = render(<ChatMessages messages={history} loading={false} />)
  rerender(<ChatMessages messages={[...history, ...newMessages]} loading={false} />)
  return container
}

/** Which rows of the transcript carry an enter mark, by their text. */
function enteringText(container: HTMLElement): string[] {
  return Array.from(entering(container), (row) => row.textContent?.trim() ?? '')
}

describe('batched arrivals', () => {
  it('reconciles a commit of twenty unseen rows on a bounded tail, not all at once', () => {
    expect(entering(arriveInOneCommit(replies(20, 1)))).toHaveLength(3)
  })

  it('animates the newest rows of a catch-up, because that is where the reader lands', () => {
    expect(enteringText(arriveInOneCommit(replies(20, 1)))).toEqual(['reply 18', 'reply 19', 'reply 20'])
  })

  it('still animates an ordinary burst that lands exactly at the cap', () => {
    expect(entering(arriveInOneCommit(replies(3, 1)))).toHaveLength(3)
  })

  it('animates a single reply arriving on its own', () => {
    expect(entering(arriveInOneCommit(replies(1, 1)))).toHaveLength(1)
  })
})

describe('reduced motion', () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: realMatchMedia, writable: true, configurable: true })
  })

  it('leaves a lone arrival unmarked so the stagger delay cannot run invisibly', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (media: string) => ({
        matches: true,
        media,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    })

    expect(entering(arriveInOneCommit(replies(1, 1)))).toHaveLength(0)
  })
})

describe('comms stagger delay', () => {
  it('spaces the rows of a burst and then stops growing', () => {
    expect(commsArrivalDelayMs(0)).toBe(0)
    expect(commsArrivalDelayMs(2)).toBe(180)
    // An index this deep would be a 2.7s tail if it were not clamped.
    expect(commsArrivalDelayMs(30)).toBe(180)
  })
})
