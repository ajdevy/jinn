import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { EdgeBackLayer } from '../edge-back-layer'
import { COMMIT_RATIO } from '../use-edge-back-gesture'

/** The shell, reduced to the two things the gesture touches: a live view it
 *  translates, and the layer mounted before it. Leaving the view unphotographed
 *  is how a test stands where retention has already dropped the copy. */
export function Shell({ label, next, photographed = true }: { label: string; next: string; photographed?: boolean }) {
  const content = useRef<HTMLDivElement>(null)
  return (
    <main>
      <EdgeBackLayer contentRef={content} />
      <div ref={photographed ? content : undefined}>
        <p>{label}</p>
        <Link to={next}>forward</Link>
      </div>
    </main>
  )
}

/** Three views in a cycle, so a trail can be walked as long as a test needs. */
export function renderShell(photographed = true): void {
  render(
    <MemoryRouter initialEntries={['/a']}>
      <Routes>
        <Route path="/a" element={<Shell label="first view" next="/b" photographed={photographed} />} />
        <Route path="/b" element={<Shell label="second view" next="/c" photographed={photographed} />} />
        <Route path="/c" element={<Shell label="third view" next="/a" photographed={photographed} />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Which view that cycle is standing on at a given depth. */
export const labelAt = (depth: number) => ['first view', 'second view', 'third view'][depth % 3]

/** One animation frame, which is when the snapshot of the painted view is taken. */
export async function paint() {
  await act(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
}

/** The live view's link, not the copy of it the layer is holding behind. */
function forwardLink() {
  const live = screen.getAllByText('forward').find(link => !link.closest('[data-testid="edge-back-layer"]'))
  if (!live) throw new Error('no live forward link on screen')
  return live
}

/** Land on the next view with the one before it behind, snapshot and all. */
export async function goForward() {
  await paint()
  await act(async () => {
    fireEvent.click(forwardLink())
  })
  await paint()
}

export function edgeDrag(distance: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 6, clientY: 400 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 6 + distance, clientY: 400, cancelable: true }))
  })
}

export const past = () => window.innerWidth * COMMIT_RATIO + 20
export const short = () => window.innerWidth * COMMIT_RATIO - 20

/** One whole back gesture: out past the threshold, let go, and let the view it
 *  landed on be photographed. */
export async function edgeBack() {
  edgeDrag(past())
  await act(async () => {
    window.dispatchEvent(new PointerEvent('pointerup'))
  })
  await paint()
}
