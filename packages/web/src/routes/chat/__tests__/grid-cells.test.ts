import { describe, expect, it } from 'vitest'
import { cellRectForIndex } from '../grid-cells'

const gridRect = { left: 20, top: 30, width: 1200, height: 720 }
const viewport = { w: 1440, h: 900 }
const metrics = { padding: 8, gap: 8 }

describe('cellRectForIndex', () => {
  it.each([
    { count: 2, index: 1, columns: 2, rows: 1 },
    { count: 3, index: 2, columns: 2, rows: 2 },
    { count: 4, index: 3, columns: 2, rows: 2 },
    { count: 5, index: 4, columns: 3, rows: 2 },
    { count: 6, index: 5, columns: 3, rows: 2 },
  ])('returns the row-major cell for $count panes on both axes', ({ count, index, columns, rows }) => {
    const result = cellRectForIndex(index, count, gridRect, viewport, metrics)
    const width = (gridRect.width - metrics.padding * 2 - metrics.gap * (columns - 1)) / columns
    const height = (gridRect.height - metrics.padding * 2 - metrics.gap * (rows - 1)) / rows
    const column = index % columns
    const row = Math.floor(index / columns)

    expect(result).toEqual({
      left: gridRect.left + metrics.padding + column * (width + metrics.gap),
      top: gridRect.top + metrics.padding + row * (height + metrics.gap),
      width,
      height,
    })
  })

  it('keeps the one-pane surface full bleed', () => {
    expect(cellRectForIndex(0, 1, gridRect, viewport, metrics)).toEqual(gridRect)
  })
})
