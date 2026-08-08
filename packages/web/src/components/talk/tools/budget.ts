/**
 * The surface's latency budget, measured rather than asserted.
 *
 * A tool call is timed from dispatch to the first frame painted after it
 * settles — the point at which the operator can actually see the result, which
 * is the only number a "faster than clicking it" claim can be made against.
 */

export const TOOL_BUDGET_MS = 300

export interface ToolTiming {
  tool: string
  ms: number
}

const MAX_TIMINGS = 20
const timings: ToolTiming[] = []

export function recordToolTiming(tool: string, ms: number): void {
  timings.push({ tool, ms: Math.round(ms * 100) / 100 })
  if (timings.length > MAX_TIMINGS) timings.shift()
}

/** Newest last. Survives route changes, so a bench can read the timing of the
 *  call that navigated away from it. */
export function toolTimings(): readonly ToolTiming[] {
  return timings
}

export function lastToolTiming(): ToolTiming | undefined {
  return timings[timings.length - 1]
}

export function clearToolTimings(): void {
  timings.length = 0
}

export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

/**
 * Run after the next painted frame. Two rAFs: the first lands before the paint
 * that follows the current commit, the second after it. jsdom has no compositor,
 * so a task-queue hop stands in there.
 */
export function afterNextPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(fn, 0)
    return
  }
  requestAnimationFrame(() => requestAnimationFrame(fn))
}
