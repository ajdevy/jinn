import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useFileDrop } from '../use-file-drop'

/* The two ways a file drag ends without a drop: the operator presses Escape, or
 * the drag leaves the window entirely and the balancing dragleave never lands.
 * Both have to put the overlay away AND rewind the enter/leave depth, or the
 * next drag starts one level deep and the overlay never appears again. */

const FILE_DRAG = { types: ['Files'], files: [] } as unknown as DataTransfer

function Harness() {
  const drop = useFileDrop()
  return <div data-testid="surface" {...drop.handlers}>{drop.dragOver ? 'over' : 'idle'}</div>
}

function dragOnto(): HTMLElement {
  const surface = screen.getByTestId('surface')
  fireEvent.dragEnter(surface, { dataTransfer: FILE_DRAG })
  expect(surface.textContent).toBe('over')
  return surface
}

describe('useFileDrop', () => {
  it('puts the overlay away on Escape and takes the next drag from zero', () => {
    render(<Harness />)
    const surface = dragOnto()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(surface.textContent).toBe('idle')

    fireEvent.dragEnter(surface, { dataTransfer: FILE_DRAG })
    expect(surface.textContent).toBe('over')
  })

  it('puts the overlay away when a drag ends off the surface', () => {
    render(<Harness />)
    const surface = dragOnto()

    fireEvent(window, new Event('dragend'))
    expect(surface.textContent).toBe('idle')
  })

  it('leaves Escape alone when nothing is being dragged', () => {
    render(<Harness />)
    const surface = screen.getByTestId('surface')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(surface.textContent).toBe('idle')
  })
})
