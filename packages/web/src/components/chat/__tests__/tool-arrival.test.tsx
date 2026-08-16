import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

function user(id: string, content: string): Message {
  return { id, role: 'user', content, timestamp: T0 }
}

/** A tool call still running: the content carries the live tool name, not "Used". */
function tool(id: string, name: string): Message {
  return { id, role: 'assistant', content: name, toolCall: name, timestamp: T0 + 1_000 }
}

function tools(count: number, from: number): Message[] {
  return Array.from({ length: count }, (_, i) => tool(`t${from + i}`, `tool_${from + i}`))
}

const HISTORY = [user('u1', 'ask')]

/** Render a transcript, then let `newMessages` arrive in a later commit — which
 *  is what separates a live arrival from a session switch. */
function arriveLive(newMessages: Message[], atMount: Message[] = HISTORY) {
  const { container, rerender } = render(<ChatMessages messages={atMount} loading={false} />)
  rerender(<ChatMessages messages={[...atMount, ...newMessages]} loading={false} />)
  return container
}

const marks = (container: HTMLElement, kind: 'group' | 'chip') =>
  Array.from(container.querySelectorAll(`[data-tool-enter="${kind}"]`))

/** Open the group so its chips are mounted, then deliver the batch. */
function arriveIntoOpenGroup(newMessages: Message[], atMount: Message[]) {
  const { container, rerender } = render(<ChatMessages messages={atMount} loading={false} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  rerender(<ChatMessages messages={[...atMount, ...newMessages]} loading={false} />)
  return container
}

describe('tool group entrance', () => {
  it('marks a group that arrives live', () => {
    expect(marks(arriveLive(tools(1, 1)), 'group')).toHaveLength(1)
  })

  it('leaves a group already present at mount unmarked, so a session switch replays nothing', () => {
    const { container } = render(
      <ChatMessages messages={[...HISTORY, ...tools(3, 1)]} loading={false} />,
    )
    expect(marks(container, 'group')).toHaveLength(0)
  })

  it('animates the arriving pill on the shared rail, not a rail of its own', () => {
    const [pill] = marks(arriveLive(tools(1, 1)), 'group') as HTMLElement[]
    expect(pill.className).toContain('tool-arrive')
  })
})

describe('tool chip stagger', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    // Beyond the cap the batch is a catch-up, so only its newest three play.
    [7, 3],
  ])('marks min(%i, 3) chips appended mid-stream', (appended, expected) => {
    const container = arriveIntoOpenGroup(tools(appended, 2), [...HISTORY, ...tools(1, 1)])
    expect(marks(container, 'chip')).toHaveLength(expected)
  })

  it('spaces the marked chips 0/90/180ms apart', () => {
    const container = arriveIntoOpenGroup(tools(3, 2), [...HISTORY, ...tools(1, 1)])
    const delays = (marks(container, 'chip') as HTMLElement[])
      .map((chip) => chip.style.getPropertyValue('--arrive-delay'))
    expect(delays).toEqual(['0ms', '90ms', '180ms'])
  })
})

describe('reduced motion', () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: realMatchMedia, writable: true, configurable: true })
  })

  it('emits no marks at all, so the stagger delay cannot run invisibly', () => {
    // `animation: none` alone would still hold each chip back by its delay, with
    // nothing to show for the wait. The JS path has to stay silent too.
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

    const container = arriveIntoOpenGroup(tools(3, 2), [...HISTORY, ...tools(1, 1)])
    expect(marks(container, 'group')).toHaveLength(0)
    expect(marks(container, 'chip')).toHaveLength(0)
  })
})
