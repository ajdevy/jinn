import { layoutFor } from './grid-layout'

export interface GridCellRect {
  left: number
  top: number
  width: number
  height: number
}

export interface GridCellViewport {
  w: number
  h: number
}

export interface GridCellMetrics {
  padding: number
  gap: number
}

/** Returns the exact row-major CSS-grid cell occupied after the pane count changes. */
export function cellRectForIndex(
  index: number,
  count: number,
  gridRect: GridCellRect,
  viewport: GridCellViewport,
  metrics: GridCellMetrics,
): GridCellRect {
  if (count <= 1) return { ...gridRect }

  const layout = layoutFor(count, viewport.w, viewport.h)
  const column = index % layout.columns
  const row = Math.floor(index / layout.columns)
  const width = (
    gridRect.width - metrics.padding * 2 - metrics.gap * (layout.columns - 1)
  ) / layout.columns
  const height = (
    gridRect.height - metrics.padding * 2 - metrics.gap * (layout.rows - 1)
  ) / layout.rows

  return {
    left: gridRect.left + metrics.padding + column * (width + metrics.gap),
    top: gridRect.top + metrics.padding + row * (height + metrics.gap),
    width,
    height,
  }
}
