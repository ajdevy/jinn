import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, render } from '@testing-library/react'
import { SETTLE_WINDOW_MS, useTranscriptOpen, type TranscriptOpenOptions } from '../transcript-open'

/**
 * The settle window is the one post-paint write the chat-open transition is
 * allowed, so its three conditions — pinned only, bottom only, bounded — are
 * what this suite holds it to.
 */

type HarnessProps = Omit<TranscriptOpenOptions, 'node'> & { ready: boolean }

function Harness(props: HarnessProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  useTranscriptOpen({ ...props, node })
  return <div data-testid="scroller" ref={setNode} />
}

interface Rig {
  writes: number
  size: number
  pinned: boolean
  clock: number
  options: HarnessProps
}

function rig(overrides: Partial<HarnessProps> = {}): Rig {
  const state: Rig = {
    writes: 0,
    size: 1000,
    pinned: true,
    clock: 0,
    options: {} as HarnessProps,
  }
  state.options = {
    ready: true,
    scrollToBottom: () => { state.writes++ },
    contentSize: () => state.size,
    isPinned: () => state.pinned,
    onOpened: () => {},
    now: () => state.clock,
    ...overrides,
  }
  return state
}

describe('useTranscriptOpen — the opening write', () => {
  it('targets the bottom through the caller, not a scrollHeight write', () => {
    const state = rig()
    render(<Harness {...state.options} />)
    expect(state.writes).toBe(1)
  })

  it('restores a remembered offset instead of snapping to the bottom first', () => {
    const state = rig({ initialScrollTop: 420 })
    const { getByTestId } = render(<Harness {...state.options} />)
    expect(getByTestId('scroller').scrollTop).toBe(420)
    expect(state.writes).toBe(0)
  })

  it('waits for content rather than opening onto an empty transcript', () => {
    const state = rig({ ready: false })
    const { rerender } = render(<Harness {...state.options} />)
    expect(state.writes).toBe(0)
    rerender(<Harness {...state.options} ready />)
    expect(state.writes).toBe(1)
  })

  it('writes nothing from a requestAnimationFrame', () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    const state = rig()
    render(<Harness {...state.options} />)
    expect(state.writes).toBe(1)
    expect(raf).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('useTranscriptOpen — the settle window', () => {
  it('re-pins while the content is still resizing', () => {
    const state = rig()
    const { rerender } = render(<Harness {...state.options} />)
    expect(state.writes).toBe(1)
    for (const size of [1400, 1800, 2100]) {
      state.size = size
      state.clock += 16
      act(() => { rerender(<Harness {...state.options} />) })
    }
    expect(state.writes).toBe(4)
  })

  it('closes at the first commit whose content size is unchanged', () => {
    const state = rig()
    const { rerender } = render(<Harness {...state.options} />)
    state.size = 1400
    state.clock = 16
    act(() => { rerender(<Harness {...state.options} />) })
    expect(state.writes).toBe(2)

    // Unchanged: the window closes here, and stays closed for a later resize.
    state.clock = 32
    act(() => { rerender(<Harness {...state.options} />) })
    state.size = 3000
    state.clock = 48
    act(() => { rerender(<Harness {...state.options} />) })
    expect(state.writes).toBe(2)
  })

  it('closes at 400ms even while the content is still growing', () => {
    const state = rig()
    const { rerender } = render(<Harness {...state.options} />)
    let size = 1000
    for (const clock of [16, 200, 399, SETTLE_WINDOW_MS, 600]) {
      size += 100
      state.size = size
      state.clock = clock
      act(() => { rerender(<Harness {...state.options} />) })
    }
    // Open, plus the three commits inside the window. 400ms is the last word.
    expect(state.writes).toBe(4)
  })

  it('stops the moment the scroller is somewhere this hook did not put it', () => {
    const state = rig()
    const { getByTestId, rerender } = render(<Harness {...state.options} />)
    state.size = 1400
    state.clock = 16
    act(() => { rerender(<Harness {...state.options} />) })
    expect(state.writes).toBe(2)

    // The reader scrolls. A commit can reach this effect before follow-intent has
    // read that event, so `isPinned` is still true here — the position is not.
    getByTestId('scroller').scrollTop = 300
    state.size = 1800
    state.clock = 32
    act(() => { rerender(<Harness {...state.options} />) })
    expect(state.writes).toBe(2)
  })

  it('writes nothing while the reader is detached', () => {
    const state = rig()
    const { rerender } = render(<Harness {...state.options} />)
    expect(state.writes).toBe(1)
    state.pinned = false
    for (const size of [1400, 1800, 2100]) {
      state.size = size
      state.clock += 16
      act(() => { rerender(<Harness {...state.options} />) })
    }
    expect(state.writes).toBe(1)
  })
})
