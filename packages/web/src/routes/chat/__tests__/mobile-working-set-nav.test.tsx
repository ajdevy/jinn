import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileWorkingSetNav } from '../mobile-working-set-nav'

vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-avatar={name}>{name}</span>,
}))

const items = [
  { id: 'a', title: 'Alpha', employee: 'builder', preview: 'alpha line', revision: 0, moved: false },
  { id: 'b', title: 'Beta', employee: 'reviewer', preview: 'beta line', revision: 0, moved: false },
  { id: 'c', title: 'Gamma', employee: 'writer', preview: 'gamma line', revision: 0, moved: false },
  { id: 'd', title: 'Delta', employee: 'operator', preview: 'delta line', revision: 0, moved: false },
]

describe('MobileWorkingSetNav', () => {
  it('keeps four keyed chips fixed while only the active chip becomes the title', () => {
    const onSelect = vi.fn()
    const view = render(<MobileWorkingSetNav items={items} activeId="a" onSelect={onSelect} />)
    const before = items.map(({ id }) => view.container.querySelector(`[data-mobile-working-set-chip="${id}"]`))

    expect(screen.getByRole('button', { name: 'Alpha — alpha line' }).textContent).toContain('Alpha')
    expect(screen.getByRole('button', { name: 'Beta — beta line' }).textContent).not.toContain('Beta')

    view.rerender(<MobileWorkingSetNav items={items.map((item) => item.id === 'c' ? { ...item, preview: 'new gamma line', revision: 1, moved: true } : item)} activeId="a" onSelect={onSelect} />)

    expect(items.map(({ id }) => view.container.querySelector(`[data-mobile-working-set-chip="${id}"]`))).toEqual(before)
    expect(view.container.querySelector('[data-mobile-working-set-chip="c"] [data-mobile-working-set-moved]')).not.toBeNull()
    expect(view.container.querySelector('[data-mobile-working-set-chip="c"] [data-mobile-working-set-preview]')?.textContent).toBe('new gamma line')
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Gamma — new gamma line' }))
    expect(onSelect).toHaveBeenCalledWith('c')
  })
})
