import React, { useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from './jump-to-latest'
import { usePersistentExpansion } from './transcript-expansion'

/* ── CollapsibleUserText — auto-collapse long user pastes ── */

// Collapsed bubbles clamp to this rendered height. ~240px ≈ 9–10 lines of the
// user bubble's subheadline/relaxed type — long enough that short prompts and
// normal multi-line questions stay fully visible, short enough that a wall of
// pasted text earns a "Show more". SLACK ensures we only collapse when there's
// something worth revealing (≥ ~2 hidden lines), so the control never appears to
// hide a single clipped word.
export const USER_COLLAPSE_PX = 240
export const USER_COLLAPSE_SLACK = 40

/** Pure: should a user bubble of this full rendered height auto-collapse? */
export function shouldCollapse(
  fullHeight: number,
  threshold = USER_COLLAPSE_PX,
  slack = USER_COLLAPSE_SLACK,
): boolean {
  return fullHeight > threshold + slack
}

// Bottom-edge fade for the collapsed state. A mask (alpha, not color) fades the
// text into the bubble's own --accent-fill background, so it is theme-aware for
// free — no hardcoded rgba, works identically in dark and light.
const COLLAPSE_FADE_MASK =
  `linear-gradient(to bottom, #000 calc(100% - 44px), transparent 100%)`

/** The bubble's own full height, re-read whenever the content reflows.
 *  scrollHeight reports it regardless of the max-height clamp, so measuring
 *  stays stable across collapse/expand (no feedback loop). */
function useFullHeight(content: React.ReactNode): [React.RefObject<HTMLDivElement | null>, number] {
  const contentRef = useRef<HTMLDivElement>(null)
  const [fullHeight, setFullHeight] = useState(0)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => setFullHeight(el.scrollHeight)
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => ro?.disconnect()
  }, [content])
  return [contentRef, fullHeight]
}

function ShowMoreToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="mt-[var(--space-1)] -ml-1.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] border-none bg-transparent py-0.5 px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
    >
      {collapsed ? 'Show more' : 'Show less'}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`transition-transform duration-200 ease-[var(--ease-smooth)] opacity-70 ${collapsed ? 'rotate-0' : 'rotate-180'}`}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  )
}

// Wraps the user bubble's formatted content. Measures the rendered height; when
// it exceeds the threshold it clamps + fades the bottom edge and reveals a quiet
// "Show more / Show less" text control. Height animates via max-height + the
// smooth easing token; reduced-motion snaps with no animation. The collapsed
// flag is keyed by message id so it outlives the row leaving the virtual window.
export function CollapsibleUserText({ messageId, children }: { messageId: string; children: React.ReactNode }) {
  const [contentRef, fullHeight] = useFullHeight(children)
  const [collapsed, setCollapsed] = usePersistentExpansion(`collapsed:${messageId}`, true)
  const reducedMotion = usePrefersReducedMotion()

  const needsCollapse = shouldCollapse(fullHeight)
  const clamped = needsCollapse && collapsed
  // +8px buffer absorbs sub-pixel/last-line rounding so expanded never clips.
  const expandedHeight = `${fullHeight + 8}px`

  return (
    <>
      <div
        ref={contentRef}
        style={{
          maxHeight: needsCollapse ? (collapsed ? `${USER_COLLAPSE_PX}px` : expandedHeight) : undefined,
          overflow: needsCollapse ? 'hidden' : undefined,
          transition:
            needsCollapse && !reducedMotion ? 'max-height 320ms var(--ease-smooth)' : undefined,
          maskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
          WebkitMaskImage: clamped ? COLLAPSE_FADE_MASK : undefined,
        }}
      >
        {children}
      </div>
      {needsCollapse && <ShowMoreToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />}
    </>
  )
}
