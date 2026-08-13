import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EdgeBackLayer } from '../edge-back-layer'
import { clearPreviousViewSnapshot } from '../previous-view-snapshot'
import { COMMIT_RATIO } from '../use-edge-back-gesture'

/** The shell, reduced to the two things the gesture touches: a live view it
 *  translates, and the layer mounted before it. */
function Shell({ label }: { label: string }) {
  const content = useRef<HTMLDivElement>(null)
  return (
    <main>
      <EdgeBackLayer contentRef={content} />
      <div ref={content}>
        <p>{label}</p>
        <Link to="/b">forward</Link>
      </div>
    </main>
  )
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/a']}>
      <Routes>
        <Route path="/a" element={<Shell label="first view" />} />
        <Route path="/b" element={<Shell label="second view" />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** One animation frame, which is when the snapshot of the painted view is taken. */
async function paint() {
  await act(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
}

/** Land on the second view with the first one behind it, snapshot and all. */
async function goForward() {
  await paint()
  await act(async () => {
    fireEvent.click(screen.getByText('forward'))
  })
  await paint()
}

function edgeDrag(distance: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 6, clientY: 400 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 6 + distance, clientY: 400, cancelable: true }))
  })
}

const past = () => window.innerWidth * COMMIT_RATIO + 20
const short = () => window.innerWidth * COMMIT_RATIO - 20

const liveView = () => screen.getByText('second view').parentElement as HTMLElement

beforeEach(() => {
  clearPreviousViewSnapshot()
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'matchMedia')
  document.documentElement.style.removeProperty('--duration-base')
})

describe('EdgeBackLayer', () => {
  it('has nothing to reveal, and so nothing to drag, on the first view', async () => {
    renderShell()
    await paint()

    edgeDrag(past())

    expect(screen.queryByTestId('edge-back-layer')).toBeNull()
    expect(screen.getByText('first view')).toBeTruthy()
  })

  it('carries the live view with the finger and reveals the previous one underneath', async () => {
    renderShell()
    await goForward()

    edgeDrag(120)

    const layer = screen.getByTestId('edge-back-layer')
    expect(layer.className).not.toContain('hidden')
    expect(liveView().style.transform).toBe('translate3d(120px, 0, 0)')
    // The layer holds a copy of the view that was on screen before this one.
    expect(layer.textContent).toContain('first view')
  })

  it('does not move for a drag that starts mid-screen', async () => {
    renderShell()
    await goForward()

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 400 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 + past(), clientY: 400, cancelable: true }))
      window.dispatchEvent(new PointerEvent('pointerup'))
    })

    expect(liveView().style.transform).toBe('')
    expect(screen.getByText('second view')).toBeTruthy()
  })

  it('goes back once the drag is let go past the threshold', async () => {
    renderShell()
    await goForward()

    edgeDrag(past())
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })

    expect(screen.getByText('first view')).toBeTruthy()
  })

  it('waits for the settle animation to finish before it swaps the view underneath', async () => {
    document.documentElement.style.setProperty('--duration-base', '180ms')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderShell()
      await goForward()

      edgeDrag(past())
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup'))
      })
      expect(screen.getByText('second view')).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180)
      })
      expect(screen.getByText('first view')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles back to rest with no navigation when the drag is let go short', async () => {
    renderShell()
    await goForward()

    edgeDrag(short())
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })

    expect(screen.getByText('second view')).toBeTruthy()
    expect(liveView().style.transform).toBe('')
  })

  it('skips the drag animation under reduced motion, and still goes back', async () => {
    // jsdom ships no matchMedia at all, which is why the app calls it optionally.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener() {},
        removeEventListener() {},
      }),
    })

    renderShell()
    await goForward()

    edgeDrag(past())
    // Nothing translated and nothing was revealed: the gesture ran invisibly.
    expect(liveView().style.transform).toBe('')
    expect(screen.getByTestId('edge-back-layer').className).toContain('hidden')

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(screen.getByText('first view')).toBeTruthy()
  })
})
