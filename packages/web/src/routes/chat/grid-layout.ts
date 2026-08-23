import { applyWorkingSetCap, type ChatWorkingSet } from './working-set'

export interface GridLayout {
  columns: number
  rows: number
}

export interface WorkingSetOverflow {
  visible: ChatWorkingSet
  foldedIds: string[]
}

const DESKTOP_PANE_FLOOR = 4
const MAX_DESKTOP_PANES = 12
const GRID_HORIZONTAL_CHROME = 376
const GRID_VERTICAL_CHROME = 120
// Three 340px columns fit beside the 376px desktop chrome at 1440px, which is
// what lets the acceptance viewport retain six panes instead of folding at four.
const MIN_PANE_WIDTH = 340
const MIN_PANE_HEIGHT = 340
const IDEAL_PANE_ASPECT = 1.25

function finiteFloor(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Pure grid geometry. Counts alone never smuggle layout breakpoints into JSX. */
export function layoutFor(count: number, width: number, height: number): GridLayout {
  const paneCount = finiteFloor(count)
  if (paneCount === 0) return { columns: 0, rows: 0 }

  const safeWidth = Math.max(1, finiteFloor(width))
  const safeHeight = Math.max(1, finiteFloor(height))
  const columns = Math.min(
    paneCount,
    Math.max(1, Math.round(Math.sqrt(
      (paneCount * safeWidth) / (safeHeight * IDEAL_PANE_ASPECT),
    ))),
  )
  return { columns, rows: Math.ceil(paneCount / columns) }
}

/** The desktop working-set capacity derived from usable pane area. Mobile owns
 * a separate four-chip awareness surface and does not mount this grid. */
export function capForViewport(width: number, height: number): number {
  const usableWidth = Math.max(0, finiteFloor(width) - GRID_HORIZONTAL_CHROME)
  const usableHeight = Math.max(0, finiteFloor(height) - GRID_VERTICAL_CHROME)
  const columns = Math.max(1, Math.floor(usableWidth / MIN_PANE_WIDTH))
  const rows = Math.max(1, Math.floor(usableHeight / MIN_PANE_HEIGHT))
  return Math.min(MAX_DESKTOP_PANES, Math.max(DESKTOP_PANE_FLOOR, columns * rows))
}

/** Applies viewport capacity while retaining presentation order. Folded ids are
 * reported in that same stable order so the list can absorb them without a jump. */
export function overflowForViewport(
  state: ChatWorkingSet,
  width: number,
  height: number,
  reservedSlots = 0,
): WorkingSetOverflow {
  const reserved = finiteFloor(reservedSlots)
  const visible = applyWorkingSetCap(state, Math.max(0, capForViewport(width, height) - reserved))
  const visibleIds = new Set(visible.sessionIds)
  return {
    visible,
    foldedIds: state.sessionIds.filter((id) => !visibleIds.has(id)),
  }
}
