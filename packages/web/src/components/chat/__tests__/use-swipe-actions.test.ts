import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AXIS_LOCK_PX, CLOSED_SWIPE, COMMIT_RATIO, reduceSwipe, useSwipeActions, type SwipeRails, type SwipeState } from '../use-swipe-actions'

const RAILS: SwipeRails = { leading: 80, trailing: 160 }

/** Replay a whole gesture so a test reads as the drag it describes. */
function drag(from: SwipeState, points: Array<[number, number]>, rails = RAILS): SwipeState {
  const [start, ...rest] = points
  let state = reduceSwipe(from, { kind: 'down', x: start[0], y: start[1] }, rails)
  for (const [x, y] of rest) state = reduceSwipe(state, { kind: 'move', x, y }, rails)
  return reduceSwipe(state, { kind: 'release' }, rails)
}

describe('reduceSwipe', () => {
  it('leaves the rail closed when the drag never reaches the commit threshold', () => {
    const short = RAILS.trailing * COMMIT_RATIO - 1
    const state = drag(CLOSED_SWIPE, [[300, 100], [300 - short, 100]])
    expect(state.offset).toBe(0)
    expect(state.openSide).toBeNull()
  })

  it('opens the trailing rail and holds it there once the drag commits', () => {
    const past = RAILS.trailing * COMMIT_RATIO + 1
    const state = drag(CLOSED_SWIPE, [[300, 100], [300 - past, 100]])
    expect(state.offset).toBe(-RAILS.trailing)
    expect(state.openSide).toBe('trailing')
  })

  it('opens the leading rail when the drag goes the other way', () => {
    const state = drag(CLOSED_SWIPE, [[100, 100], [100 + RAILS.leading, 100]])
    expect(state.offset).toBe(RAILS.leading)
    expect(state.openSide).toBe('leading')
  })

  it('clamps the offset to the rail width so the row cannot be dragged off its own list', () => {
    const mid = reduceSwipe(
      reduceSwipe(CLOSED_SWIPE, { kind: 'down', x: 300, y: 100 }, RAILS),
      { kind: 'move', x: 300 - RAILS.trailing * 3, y: 100 },
      RAILS,
    )
    expect(mid.offset).toBe(-RAILS.trailing)
  })

  it('cannot be dragged towards a rail that does not exist', () => {
    const rails: SwipeRails = { leading: 0, trailing: 160 }
    const state = drag(CLOSED_SWIPE, [[100, 100], [400, 100]], rails)
    expect(state.offset).toBe(0)
    expect(state.openSide).toBeNull()
  })

  it('ignores a predominantly vertical drag entirely, so the list keeps scrolling', () => {
    const state = drag(CLOSED_SWIPE, [[300, 100], [290, 160], [140, 400]])
    expect(state.offset).toBe(0)
    expect(state.openSide).toBeNull()
  })

  it('commits to no axis until the finger has travelled the lock distance', () => {
    const state = reduceSwipe(
      reduceSwipe(CLOSED_SWIPE, { kind: 'down', x: 300, y: 100 }, RAILS),
      { kind: 'move', x: 300 - (AXIS_LOCK_PX - 1), y: 100 },
      RAILS,
    )
    expect(state.axis).toBeNull()
    expect(state.offset).toBe(0)
  })

  it('keeps a locked axis for the rest of the gesture even if the finger turns', () => {
    const state = drag(CLOSED_SWIPE, [[300, 100], [300, 100 + AXIS_LOCK_PX * 2], [100, 120]])
    expect(state.offset).toBe(0)
  })

  it('resumes an open row from where it sits, and closes it on a drag back', () => {
    const open = drag(CLOSED_SWIPE, [[300, 100], [300 - RAILS.trailing, 100]])
    expect(open.openSide).toBe('trailing')

    const nudged = drag(open, [[100, 100], [110, 100]])
    expect(nudged.openSide).toBe('trailing')

    const closed = drag(open, [[100, 100], [100 + RAILS.trailing, 100]])
    expect(closed.offset).toBe(0)
    expect(closed.openSide).toBeNull()
  })

  it('closes on demand', () => {
    const open = drag(CLOSED_SWIPE, [[300, 100], [300 - RAILS.trailing, 100]])
    expect(reduceSwipe(open, { kind: 'close' }, RAILS)).toEqual(CLOSED_SWIPE)
  })

  it('ignores movement that arrives without a gesture in progress', () => {
    expect(reduceSwipe(CLOSED_SWIPE, { kind: 'move', x: 0, y: 0 }, RAILS)).toEqual(CLOSED_SWIPE)
  })
})

describe('useSwipeActions', () => {
  const pointerDown = (x: number, y: number) =>
    ({ clientX: x, clientY: y }) as React.PointerEvent<HTMLElement>

  it('presses on pointer-down and lets go the moment the touch becomes a drag', () => {
    const { result } = renderHook(() => useSwipeActions(RAILS))
    expect(result.current.pressing).toBe(false)

    act(() => result.current.onPointerDown(pointerDown(300, 100)))
    expect(result.current.pressing).toBe(true)

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 260, clientY: 100 }))
    })
    expect(result.current.pressing).toBe(false)
  })

  it('releases the press when the pointer lifts without moving', () => {
    const { result } = renderHook(() => useSwipeActions(RAILS))
    act(() => result.current.onPointerDown(pointerDown(300, 100)))
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(result.current.pressing).toBe(false)
  })

  it('tracks a drag through window pointer events and reports the open side', () => {
    const { result } = renderHook(() => useSwipeActions(RAILS))
    expect(result.current.openSide).toBeNull()

    act(() => result.current.onPointerDown(pointerDown(300, 100)))
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 - RAILS.trailing, clientY: 100 }))
    })
    expect(result.current.dragging).toBe(true)
    expect(result.current.offset).toBe(-RAILS.trailing)

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(result.current.dragging).toBe(false)
    expect(result.current.openSide).toBe('trailing')

    act(() => result.current.close())
    expect(result.current.openSide).toBeNull()
    expect(result.current.offset).toBe(0)
  })

  it('swallows the click a finished drag leaves behind, but not an ordinary tap', () => {
    const { result } = renderHook(() => useSwipeActions(RAILS))
    const click = () => {
      const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent
      act(() => result.current.onClickCapture(event))
      return event
    }

    expect(click().stopPropagation).not.toHaveBeenCalled()

    act(() => result.current.onPointerDown(pointerDown(300, 100)))
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 100 }))
      window.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(click().stopPropagation).toHaveBeenCalled()
    // Only the one click: the tap after it is the user's, not the gesture's.
    expect(click().stopPropagation).not.toHaveBeenCalled()
  })

  it('treats a cancelled pointer as a release rather than leaving the row stuck mid-drag', () => {
    const { result } = renderHook(() => useSwipeActions(RAILS))
    act(() => result.current.onPointerDown(pointerDown(300, 100)))
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 290, clientY: 100 }))
      window.dispatchEvent(new PointerEvent('pointercancel'))
    })
    expect(result.current.dragging).toBe(false)
    expect(result.current.offset).toBe(0)
  })
})
