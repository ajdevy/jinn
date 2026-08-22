import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ANCHOR_WINDOW_MS, anchorScrollDuring, canAnchorFold, foldIsAboveViewport } from './fold-anchor'
import { FOLD_LANDING_PAD_MS, FOLD_MS, FOLD_TRANSITION } from './fold-motion'
import { FoldSummaryLine, type FoldSummaryData } from './fold-summary'

/**
 * The post-turn fold: once the user moves on from an answered turn, EVERYTHING
 * between the user message and that answer — tool groups, interim prose, callbacks,
 * relays, delegation and dispatch rows — files itself away into ONE ledger
 * summary line ("Worked for 7m · 6 tools · 3 teammates"), expandable at any
 * time. The final answer, system banners, and media-bearing messages stay outside.
 *
 * The premium detail: the fold happens ABOVE the answer the user is reading,
 * so a naive collapse would yank the answer up. Both directions are
 * scroll-anchored — each frame the scroll container compensates by the height
 * delta, so the answer stays pixel-fixed in the viewport while the evidence
 * folds away or comes back. The browser's own `overflow-anchor` does not stand
 * in for this: measured on a mid-viewport strip it left the row 146px lower
 * than it found it, and Safari implements none at all.
 * `prefers-reduced-motion` swaps instantly with a single compensation.
 *
 * And a send is not a reason to move anything: the next ask only files away a
 * region that has already scrolled off the top and that the reader is not
 * touching. What is on screen stays as they left it.
 */

/** Held so an interrupted toggle can drop the frame it has not run yet. */
type FrameRef = { current: number | undefined }

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function scheduleFrame(ref: FrameRef, run: () => void): void {
  ref.current = requestAnimationFrame(() => {
    ref.current = undefined
    run()
  })
}

function cancelPendingFrame(ref: FrameRef): void {
  if (ref.current !== undefined) cancelAnimationFrame(ref.current)
  ref.current = undefined
}

/**
 * Hold everything below `wrap` pixel-fixed across a height change this commit
 * already made — the paths that swap instantly instead of animating into it.
 *
 * It yields the same way the anchor loop does: finding the scroller somewhere
 * else means the reader is mid-drag, or the browser's own overflow-anchor has
 * already done this job. Writing on top of either is what makes a swipe stick.
 */
function compensateNextFrame(scroller: Element | null, wrap: Element, bottom0: number): void {
  if (!scroller) return
  const from = scroller.scrollTop
  requestAnimationFrame(() => {
    if (Math.abs(scroller.scrollTop - from) > 1) return
    const delta = wrap.getBoundingClientRect().bottom - bottom0
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
  })
}

interface FoldRegionProps {
  /** Whether the turn already produced its final answer (fold-eligible). */
  answered: boolean
  /** The final answer arrived while this chat was mounted. Start open so the
   *  work remains visible until the user scrolls past it. */
  liveCompletion?: boolean
  /** A later user message now exists after this answer. A request, not an
   *  order: the region declines it while any of it is still on screen. */
  collapseRequested?: boolean
  summary: FoldSummaryData
  /** Whether this region plays the anchored live-fold choreography. False for
   *  the earlier siblings of a banner/media-split turn: they answer at the same
   *  instant, and two concurrent anchor loops would double-compensate the
   *  shared scroller — so siblings fold with the instant path. */
  animated?: boolean
  /** Windowed transcript: a folded region drops its evidence instead of mounting it — folded it is inert, aria-hidden and zero-height, so nothing can read it. */
  windowed?: boolean
  children: ReactNode
}

export function FoldRegion({ answered, liveCompletion = false, collapseRequested = false, summary, animated = true, windowed = false, children }: FoldRegionProps) {
  // Historical turns rest folded; a live completion stays open until the reader
  // scrolls past it. `liveCompletion` distinguishes those cases on first mount.
  const startsAnswered = answered && !liveCompletion
  const [folded, setFolded] = useState(startsAnswered)
  // The ledger line does NOT arrive in the answer's own commit — mounting it
  // there would push the answer down at the stream→final swap and break the
  // structural-parity guarantee. It follows a commit later, compensated.
  const [summaryVisible, setSummaryVisible] = useState(startsAnswered)
  const [landing, setLanding] = useState(false)
  // True while the collapse animation plays: the region is still visually open
  // (folded stays false until the animation lands) but the control already
  // reads as closed.
  const [closing, setClosing] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const regionRef = useRef<HTMLDivElement | null>(null)
  // The reader is on this region right now. A request to file it away is
  // declined while that is true, the same way it is declined for a region still
  // on screen — and it is not re-queued for later.
  const hoveredRef = useRef(false)
  const foldedRef = useRef(folded)
  foldedRef.current = folded
  const animatedRef = useRef(animated)
  animatedRef.current = animated
  const foldTimerRef = useRef<number | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  const anchorCancelRef = useRef<(() => void) | null>(null)

  // Every answered region owes the reader a control — the one left open because
  // its answer landed live most of all, since nothing else will put it away.
  useEffect(() => {
    if (!answered || summaryVisible) return
    const wrap = wrapRef.current
    if (!wrap) return
    const bottom0 = wrap.getBoundingClientRect().bottom
    setSummaryVisible(true)
    setLanding(true)
    compensateNextFrame(wrap.closest('.chat-messages-scroll'), wrap, bottom0)
  }, [answered, summaryVisible])

  // Live fold: the evidence files away on the next ask, and only from above the
  // reader's viewport. A region with any part of it on screen keeps the state
  // the reader left it in, for good.
  useEffect(() => {
    if (!collapseRequested || foldedRef.current) return

    const region = regionRef.current
    const wrap = wrapRef.current
    if (!region || !wrap) return
    const scroller = wrap.closest('.chat-messages-scroll')
    if (!scroller) return
    if (!foldIsAboveViewport(wrap.getBoundingClientRect(), scroller.getBoundingClientRect())) return
    if (hoveredRef.current || wrap.contains(document.activeElement)) return

    cancelPendingFrame(frameRef)
    window.clearTimeout(foldTimerRef.current)
    anchorCancelRef.current?.()

    const bottom0 = wrap.getBoundingClientRect().bottom
    if (prefersReducedMotion() || !animatedRef.current || !canAnchorFold(scroller.scrollTop, region.offsetHeight)) {
      setFolded(true)
      compensateNextFrame(scroller, wrap, bottom0)
      return
    }

    // `closing` for the same reason the manual collapse sets it: while the
    // animation plays the region is still visually open, and without it a click
    // mid-fold reads the region as open and aims at a collapse already running.
    setLanding(true)
    setClosing(true)
    // The from-height is measured here, not a frame later: motion starts on the
    // very next frame, with nothing between the request and it.
    region.style.height = `${region.offsetHeight}px`
    region.style.overflow = 'hidden'
    scheduleFrame(frameRef, () => {
      region.style.transition = FOLD_TRANSITION
      region.style.height = '0px'
      region.style.opacity = '0'
      anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS, { referenceBottom: bottom0 })
      foldTimerRef.current = window.setTimeout(() => {
        setFolded(true)
        setLanding(false)
        setClosing(false)
        region.style.transition = ''
      }, FOLD_MS + FOLD_LANDING_PAD_MS)
    })
  }, [collapseRequested])

  // A stale timer, frame or anchor loop must not outlive the component.
  useEffect(() => () => {
    window.clearTimeout(foldTimerRef.current)
    cancelPendingFrame(frameRef)
    anchorCancelRef.current?.()
  }, [])

  // Inert bookkeeping happens via state; keep the region inert when folded.
  useLayoutEffect(() => {
    const region = regionRef.current
    if (!region) return
    if (folded) {
      region.style.height = '0px'
      region.style.opacity = '0'
      region.style.overflow = 'hidden'
    }
  }, [folded])

  // Manual toggle: BOTH directions play the same height+opacity timeline,
  // scroll-anchored on the wrap so the summary row under the pointer and the
  // answer below stay pixel-fixed while the evidence grows or folds above
  // them. Interruptible: a click mid-animation re-targets from the current
  // height, and one click always reaches the opposite state.
  const toggle = () => {
    const region = regionRef.current
    const wrap = wrapRef.current
    if (!region || !wrap) return
    const scroller = wrap.closest('.chat-messages-scroll')
    // Whatever was in flight loses — the frame it has not run yet, the timer
    // that would commit its end state, and its anchor loop. Leave any of the
    // three alive and the loser's timer lands after the winner's, resting the
    // region in the state nobody asked for.
    cancelPendingFrame(frameRef)
    window.clearTimeout(foldTimerRef.current)
    anchorCancelRef.current?.()
    const isOpen = !folded && !closing

    if (prefersReducedMotion()) {
      const bottom0 = wrap.getBoundingClientRect().bottom
      if (isOpen) {
        setFolded(true)
      } else {
        setClosing(false)
        setFolded(false)
        region.style.height = 'auto'
        region.style.opacity = ''
        region.style.overflow = ''
      }
      compensateNextFrame(scroller, wrap, bottom0)
      return
    }

    if (!isOpen) {
      // Expand — from the current height (0 at rest, a mid-value when a
      // collapse gets interrupted) up to the content height.
      setClosing(false)
      setFolded(false)
      region.style.overflow = 'hidden'
      scheduleFrame(frameRef, () => {
        region.style.transition = FOLD_TRANSITION
        region.style.height = `${region.scrollHeight}px`
        region.style.opacity = '1'
        anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS)
        foldTimerRef.current = window.setTimeout(() => {
          // Rest at `auto`. A clamped pixel height would freeze the region at
          // whatever the content measured the moment it opened.
          region.style.transition = ''
          region.style.height = 'auto'
          region.style.opacity = ''
          region.style.overflow = ''
        }, FOLD_MS + FOLD_LANDING_PAD_MS)
      })
    } else {
      // Collapse — the folded state commits AFTER the animation lands; the
      // folded layout-effect would snap the height to 0 on the same frame
      // otherwise. `closing` carries the control state in the meantime.
      setClosing(true)
      region.style.overflow = 'hidden'
      region.style.height = `${region.offsetHeight}px`
      scheduleFrame(frameRef, () => {
        region.style.transition = FOLD_TRANSITION
        region.style.height = '0px'
        region.style.opacity = '0'
        anchorCancelRef.current = anchorScrollDuring(scroller, wrap, ANCHOR_WINDOW_MS)
        foldTimerRef.current = window.setTimeout(() => {
          setFolded(true)
          setClosing(false)
          region.style.transition = ''
        }, FOLD_MS + FOLD_LANDING_PAD_MS)
      })
    }
  }

  return (
    <div
      ref={wrapRef}
      data-fold
      data-folded={folded || undefined}
      onMouseEnter={() => { hoveredRef.current = true }}
      onMouseLeave={() => { hoveredRef.current = false }}
    >
      <div ref={regionRef} data-fold-region inert={folded || undefined} aria-hidden={folded || undefined}>{folded && windowed ? null : children}</div>
      {summaryVisible && (
        <FoldSummaryLine
          summary={summary}
          closed={folded || closing}
          arriving={landing}
          onToggle={toggle}
        />
      )}
    </div>
  )
}
