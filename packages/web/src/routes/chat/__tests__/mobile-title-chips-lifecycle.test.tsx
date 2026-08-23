import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { useMobileWorkingSet } from '../use-mobile-working-set'

// The chips' opening preview fetch says nothing about the entrance, and one
// that never settles keeps its state update from landing outside `act`.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionMessages: () => new Promise(() => {}) } }
})

vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}))

const noop = () => {}

const sessions = [
  { id: 'a', title: 'Release plan', employee: 'builder' },
  { id: 'b', title: 'Weekly digest', employee: 'reviewer' },
]

/** The nav bar with the page's own wiring: `useMobileWorkingSet` decides from
 *  the working set whether the chips take the centre track, and the header
 *  hands that track to them or to the centred title. */
function NavBar({ title, memberIds }: { title: string; memberIds: string[] }) {
  const mobileWorkingSet = useMobileWorkingSet({
    sessionIds: memberIds,
    activeId: memberIds[0] ?? null,
    sessions,
    subscribe: () => noop,
    connectionSeq: 0,
    onSelect: noop,
  })
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} mobileWorkingSet={mobileWorkingSet} />
}

const entering = (container: HTMLElement) => container.querySelectorAll('[data-title-enter]')
const chipsUp = (container: HTMLElement) =>
  container.querySelectorAll('[data-mobile-working-set-chip]').length > 0
/** The centred nav-bar title, the span the chips take the track from. */
const centredTitle = (container: HTMLElement) => container.querySelector('span.text-center')

describe('chat title entrance across the working-set chips lifecycle', () => {
  it('drops an entrance the chips interrupted, so the span they hand back mounts unmarked', () => {
    const { container, rerender } = render(<NavBar title="Release plan" memberIds={['a']} />)
    expect(chipsUp(container)).toBe(false)
    expect(entering(container)).toHaveLength(0)

    // The reader watches this one arrive, so it animates. The mark it takes here
    // stays live, inside its one-second TTL, for the rest of the case.
    rerender(<NavBar title="Weekly digest" memberIds={['a']} />)
    expect(entering(container)).toHaveLength(1)

    // A second member joins the working set, so the chips take the centre track
    // and the span is unmounted mid-entrance.
    rerender(<NavBar title="Weekly digest" memberIds={['a', 'b']} />)
    expect(chipsUp(container)).toBe(true)
    expect(entering(container)).toHaveLength(0)

    // The conversation switches entirely behind the chips.
    rerender(<NavBar title="Sprint retro" memberIds={['a', 'b']} />)
    expect(chipsUp(container)).toBe(true)
    expect(entering(container)).toHaveLength(0)

    // The member leaves well inside the TTL and the chips stand down. A span that
    // comes back is a mount, and mounts animate nothing.
    rerender(<NavBar title="Sprint retro" memberIds={['a']} />)
    expect(chipsUp(container)).toBe(false)
    const returned = centredTitle(container)
    expect(returned?.textContent).toBe('Sprint retro')
    expect(returned?.hasAttribute('data-title-enter')).toBe(false)
    expect(entering(container)).toHaveLength(0)
  })
})
