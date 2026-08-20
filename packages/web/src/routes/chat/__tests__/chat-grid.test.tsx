import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatGrid } from '../chat-grid'

describe('live chat grid', () => {
  it('mounts four stable panes, focuses one, and removes only through its X', () => {
    const onFocus = vi.fn()
    const onRemove = vi.fn()
    const { rerender } = render(
      <ChatGrid
        sessionIds={['a', 'b', 'c', 'd']}
        focusedId="c"
        width={1440}
        height={900}
        onFocus={onFocus}
        onRemove={onRemove}
        renderPane={(id, active) => <output data-testid={`content-${id}`} data-active={String(active)} />}
      />,
    )

    const streamingNode = screen.getByTestId('pane-c')
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(4)
    expect(screen.getByTestId('content-c').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('chat-grid').getAttribute('data-columns')).toBe('2')

    fireEvent.click(screen.getByTestId('pane-b'))
    expect(onFocus).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: 'Close b' }))
    expect(onRemove).toHaveBeenCalledWith('b')

    rerender(
      <ChatGrid
        sessionIds={['a', 'c', 'd']}
        focusedId="c"
        width={1440}
        height={900}
        onFocus={onFocus}
        onRemove={onRemove}
        renderPane={(id, active) => <output data-testid={`content-${id}`} data-active={String(active)} />}
      />,
    )
    expect(screen.getByTestId('pane-c')).toBe(streamingNode)
  })

  it('renders one pane without grid chrome', () => {
    render(
      <ChatGrid
        sessionIds={['only']}
        focusedId="only"
        width={1440}
        height={900}
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        renderPane={() => <output>Only pane</output>}
      />,
    )

    expect(screen.getByTestId('chat-grid').getAttribute('data-single-pane')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Close only' })).toBeNull()
  })
})
