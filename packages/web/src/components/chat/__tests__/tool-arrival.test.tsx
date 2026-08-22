import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { ToolGroup } from '../tool-group'
import { TranscriptExpansionProvider } from '../transcript-expansion'
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

const marks = (container: HTMLElement, kind: 'group' | 'chip' | 'expand') =>
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

  it('marks a group that opens with more calls than the rail has slots', () => {
    // The rail animates the newest three of a commit, so a group opening with
    // four leaves its FIRST call unmarked — the pill still has to enter, on
    // whichever of its calls did get a slot.
    const [pill] = marks(arriveLive(tools(4, 1)), 'group') as HTMLElement[]
    expect(pill).toBeTruthy()
    expect(pill.style.getPropertyValue('--arrive-delay')).toBe('0ms')
  })

  it('leaves the pill unmarked when a call lands in a group already on screen', () => {
    const container = arriveIntoOpenGroup(tools(2, 2), [...HISTORY, ...tools(1, 1)])
    expect(marks(container, 'group')).toHaveLength(0)
    expect(marks(container, 'chip')).toHaveLength(2)
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

/** A group nothing arrived into: every call was present at mount. Opening it is
 *  the reader's own act, so its chips owe an entrance the live rail never gave
 *  them. */
function openSettledGroup(count: number) {
  const rendered = render(<ChatMessages messages={[...HISTORY, ...tools(count, 1)]} loading={false} />)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return rendered
}

/** One transcript's expansion store, shared across a row that unmounts and comes
 *  back — what a windowed transcript does when the reader scrolls away. */
function settledGroupInStore(store: Map<string, boolean>, count: number) {
  return render(
    <TranscriptExpansionProvider value={store}>
      <ToolGroup
        msgs={tools(count, 1)}
        isActive={false}
        groupId="g1"
        arrivals={new Map()}
        isEntering={() => false}
      />
    </TranscriptExpansionProvider>,
  )
}

describe('tool chip entrance on expand', () => {
  it('animates the chips the reader just revealed, staggered on the shared rail', () => {
    const { container } = openSettledGroup(3)

    const chips = marks(container, 'expand') as HTMLElement[]
    expect(chips).toHaveLength(3)
    expect(chips.map((chip) => chip.style.getPropertyValue('--arrive-delay'))).toEqual(['0ms', '90ms', '180ms'])
    expect(chips.every((chip) => chip.className.includes('tool-arrive'))).toBe(true)
  })

  it('leaves the live rail to the calls that arrived live', () => {
    // Opening the group must not relabel a chip the arrival rail already owns,
    // or a live burst would enter twice on two different staggers.
    const container = arriveIntoOpenGroup(tools(2, 2), [...HISTORY, ...tools(1, 1)])
    expect(marks(container, 'chip')).toHaveLength(2)
    expect(marks(container, 'expand')).toHaveLength(1)
  })

  it('does not re-run the stagger when an open group re-renders', () => {
    const { container, rerender } = openSettledGroup(3)
    const before = marks(container, 'expand')

    rerender(<ChatMessages messages={[...HISTORY, ...tools(3, 1)]} loading={false} />)

    const after = marks(container, 'expand')
    expect(after).toHaveLength(3)
    // Same nodes carrying the same delays: nothing remounted, so the CSS
    // animation cannot restart under the reader.
    expect(after.every((chip, index) => chip === before[index])).toBe(true)
  })

  it('leaves a group that comes back already open unmarked', () => {
    const store = new Map<string, boolean>()
    const opened = settledGroupInStore(store, 3)
    expect(marks(opened.container, 'expand')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(marks(opened.container, 'expand')).toHaveLength(3)
    opened.unmount()

    const restored = settledGroupInStore(store, 3)

    // The expansion survived the row; the entrance does not repeat with it.
    expect(restored.container.querySelector('[data-testid="tool-group-list"]')).not.toBeNull()
    expect(marks(restored.container, 'expand')).toHaveLength(0)
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

describe('rows that render nothing', () => {
  /** The block that renders a handoff; its own `delegate_task` calls are then
   *  dropped by grouping and never reach the DOM. */
  const handoff: Message = {
    id: 'h1',
    role: 'assistant',
    content: 'Handed off',
    timestamp: T0 + 2_000,
    blocks: [{
      id: 'dg-1',
      type: 'delegation',
      version: 1,
      status: 'running',
      payload: {
        employee: 'researcher',
        employeeDisplay: 'Researcher',
        title: 'Research the issue',
        childSessionId: 'child-1',
        workItemId: 'wi-1',
        dispatchedAt: T0,
      },
    }],
  }

  it('does not let them spend the arrival slots the visible chip needs', () => {
    // Three dropped rows arriving after the tool call fill the batch's tail. A
    // cap counted on raw messages hands every slot to rows with no DOM, and the
    // chip beside them — the one the reader is actually watching — pops in.
    const container = arriveLive([
      tool('t1', 'grep'),
      handoff,
      tool('d1', 'delegate_task'),
      tool('d2', 'delegate_task'),
      tool('d3', 'delegate_task'),
    ])

    const pills = marks(container, 'group')
    expect(pills).toHaveLength(1)
    expect((pills[0] as HTMLElement).className).toContain('tool-arrive')
  })
})

describe('rows that carry their own arrival', () => {
  /** A delegation block animates on its own rail — `use-live-session` mints the
   *  arrival and `ChatBlockInline` plays `.delegation-arrival` for it. */
  function delegation(id: string, at: number): Message {
    return {
      id,
      role: 'assistant',
      content: 'Handed off',
      timestamp: at,
      blocks: [{
        id: `dg-${id}`,
        type: 'delegation',
        version: 1,
        status: 'running',
        payload: { employee: 'researcher', employeeDisplay: 'Researcher', title: 'Research', childSessionId: `c-${id}`, workItemId: `wi-${id}`, dispatchedAt: T0 },
      }],
    }
  }

  it('leaves the generic slots to the chip beside them', () => {
    // Three delegations landing after a tool call would fill the batch's tail.
    // They are already animating, so spending the slots on them buys nothing
    // and costs the chip the only entrance it has.
    const container = arriveLive([
      tool('t1', 'grep'),
      delegation('d1', T0 + 3_000),
      delegation('d2', T0 + 4_000),
      delegation('d3', T0 + 5_000),
    ])

    const pills = marks(container, 'group')
    expect(pills).toHaveLength(1)
    expect((pills[0] as HTMLElement).className).toContain('tool-arrive')
  })

  it('does not also hand them the generic message entrance', () => {
    const arrivals = new Map([['dg-d1', { nonce: 1, delayMs: 0 }]])
    const { container, rerender } = render(<ChatMessages messages={HISTORY} loading={false} blockArrivals={arrivals} />)
    rerender(<ChatMessages messages={[...HISTORY, delegation('d1', T0 + 3_000)]} loading={false} blockArrivals={arrivals} />)

    // Its own rail plays, and nothing plays on top of it.
    expect(container.querySelectorAll('[data-delegation-arrival]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-msg-enter]')).toHaveLength(0)
  })
})
