import { useEffect, useLayoutEffect, useState } from 'react'

/**
 * Whether a finger — or the glide it left behind — still owns a scroller.
 *
 * WebKit ends an in-flight fling the instant anything assigns `scrollTop`. A
 * correction issued while the list is still gliding therefore does not read as a
 * correction: it reads as the list stopping dead the moment the reader lifts,
 * sticky to the finger instead of sliding. So a write nobody asked for waits
 * here, and the reader's own scroll is never the thing being held.
 *
 * The phase opens on `touchstart` and stays open past `touchend` for as long as
 * scroll events keep arriving. Momentum is still running then, and the stretch
 * after the lift is the whole of what the reader notices.
 */

/** How long the scroller must stay quiet after a lift before the glide is over. */
const SETTLE_MS = 120

interface TouchScrollPhase {
  live: boolean
  /** Corrections held out of the phase, summed as one delta — see `holdScrollAdjustment`. */
  held: number
  /** The running total already counted into `held` — see the same. */
  counted: number
  apply: ((total: number) => void) | null
  settle: ReturnType<typeof setTimeout> | null
}

const phases = new WeakMap<Element, TouchScrollPhase>()

/** True while a touch drag or its momentum still owns this scroller. */
export function touchScrollLive(el: Element): boolean {
  return phases.get(el)?.live ?? false
}

/**
 * Hold a scroll correction until the glide finishes, then apply the total.
 *
 * Kept as a delta rather than as the offset the correction was computed for: by
 * the time the list settles the reader is somewhere else entirely, and what the
 * correction describes is content that re-measured above them — true from
 * wherever they land, which that offset is not.
 *
 * `adjustment` arrives as the virtualizer's running total since the scroller
 * last reported a position, not as one row's contribution, and it restarts from
 * zero on every scroll event. So it is the increment that gets banked; adding
 * the value itself would count each earlier row again on every row after it.
 */
export function holdScrollAdjustment(el: Element, adjustment: number, apply: (total: number) => void): void {
  const phase = phases.get(el)
  if (!phase) return
  phase.held += adjustment - phase.counted
  phase.counted = adjustment
  phase.apply = apply
}

/** Forget a held correction — a deliberate scroll has replaced where it aimed. */
export function dropHeldScrollAdjustment(el: Element): void {
  const phase = phases.get(el)
  if (!phase) return
  phase.held = 0
  phase.counted = 0
  phase.apply = null
}

function endPhase(phase: TouchScrollPhase): void {
  phase.live = false
  const { held, apply } = phase
  phase.held = 0
  phase.counted = 0
  phase.apply = null
  if (held !== 0) apply?.(held)
}

/** Watch a scroller's touch phase for as long as the component stays mounted. */
export function useTouchScrollPhase(getScrollElement: () => HTMLElement | null): void {
  // Through state rather than read once: the scrollport is an ancestor, so the
  // ref behind `getScrollElement` is still empty on the first pass. Unkeyed like
  // `useVirtualBlockOffset` next door, and setting the same element bails out.
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setEl(getScrollElement()) })

  useEffect(() => {
    if (!el) return
    const phase: TouchScrollPhase = { live: false, held: 0, counted: 0, apply: null, settle: null }
    phases.set(el, phase)

    const settleAfterQuiet = () => {
      if (phase.settle) clearTimeout(phase.settle)
      phase.settle = setTimeout(() => { phase.settle = null; endPhase(phase) }, SETTLE_MS)
    }
    const onTouchStart = () => {
      phase.live = true
      if (phase.settle) { clearTimeout(phase.settle); phase.settle = null }
    }
    // Quiet only means anything once the finger is up: a scroll event during the
    // drag is the drag, and waiting it out would hold every correction forever.
    // The reported position is also where the virtualizer restarts its running
    // adjustment total, so the banking in `holdScrollAdjustment` restarts here too.
    const onScroll = () => {
      phase.counted = 0
      if (phase.settle) settleAfterQuiet()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', settleAfterQuiet, { passive: true })
    el.addEventListener('touchcancel', settleAfterQuiet, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', settleAfterQuiet)
      el.removeEventListener('touchcancel', settleAfterQuiet)
      el.removeEventListener('scroll', onScroll)
      if (phase.settle) clearTimeout(phase.settle)
      phases.delete(el)
    }
  }, [el])
}
