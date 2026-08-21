import { useLayoutEffect, useState } from 'react'

/**
 * How far the virtual block starts below the scrollport's top — the header
 * padding, plus whatever the transcript renders in front of it.
 *
 * Measured rather than assumed: the padding is one breakpoint away from a
 * different number, and the older-page row comes and goes. Unkeyed on purpose,
 * because there is no render that cannot move it, and it only re-renders when
 * the answer actually changes.
 *
 * The transcript declares it to the virtualizer as `scrollMargin` — see the
 * header of `transcript-virtualizer.ts` for what goes wrong when it does not.
 */
export function useVirtualBlockOffset(
  blockRef: React.RefObject<HTMLDivElement | null>,
  getScrollElement: () => HTMLDivElement | null,
): number {
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => {
    const block = blockRef.current
    const node = getScrollElement()
    if (!block || !node) return
    const next = block.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
    setOffset((prev) => (Math.abs(prev - next) > 0.5 ? next : prev))
  })
  return offset
}
