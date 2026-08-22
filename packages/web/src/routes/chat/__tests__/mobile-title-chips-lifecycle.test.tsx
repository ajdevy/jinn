import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { MobileWorkingSetNav } from '../mobile-working-set-nav'

vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}))

const noop = () => {}

const chips = ['Release plan', 'Weekly digest', 'Inbox sweep', 'Handover'].map((title, index) => ({
  id: `s${index}`, title, employee: 'builder', preview: `${title} line`, revision: 0, moved: false,
}))

/** The nav bar as the phone commits it: the working-set chips take the centre
 *  track while they are up and the centred title has it back once they stand
 *  down — the same slot the page hands to one or the other, never both. */
function navBar(title: string, chipsUp: boolean) {
  return (
    <ChatHeaderPills
      title={title}
      onNew={noop}
      onBack={noop}
      mobileWorkingSet={chipsUp
        ? <MobileWorkingSetNav items={chips} activeId={chips[0].id} onSelect={noop} />
        : undefined}
    />
  )
}

const entering = (container: HTMLElement) => container.querySelectorAll('[data-title-enter]')

describe('chat title entrance across the working-set chips lifecycle', () => {
  it('does not replay the entrance when the chips hand the track back', () => {
    const { container, rerender } = render(navBar('Release plan', false))

    // The reader watches this one arrive, and it animates — once.
    rerender(navBar('Weekly digest', false))
    expect(entering(container)).toHaveLength(1)

    // The chips take the track, so the span that animated is unmounted.
    rerender(navBar('Weekly digest', true))
    expect(container.querySelector('[data-mobile-working-set-chip="s0"]')).not.toBeNull()
    expect(entering(container)).toHaveLength(0)

    // Well inside the mark's TTL the chips stand down and the same title comes
    // back. A span that comes back is a mount, and mounts animate nothing.
    rerender(navBar('Weekly digest', false))
    expect(entering(container)).toHaveLength(0)
  })
})
