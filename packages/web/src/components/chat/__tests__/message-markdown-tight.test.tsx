import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { formatMessage } from '../message-markdown'

// User bubbles render tight lines: a single Enter is a line break carried by
// line-height alone; assistant markdown keeps the 8px per-line paragraph
// margin. Blank lines stay the paragraph gap in both variants.

describe('formatMessage tightLines variant', () => {
  const MULTILINE = 'first line\nsecond line\n\nnew paragraph'

  it('default (assistant) keeps the 8px per-line margin', () => {
    const { container } = render(<div>{formatMessage(MULTILINE)}</div>)
    const margins = container.querySelectorAll('[class*="mb-[var(--space-2)]"]')
    expect(margins.length).toBe(3)
  })

  it('tight (user) drops the per-line margin but keeps a blank-line paragraph gap', () => {
    const { container } = render(<div>{formatMessage(MULTILINE, { tightLines: true })}</div>)
    expect(container.querySelectorAll('[class*="mb-[var(--space-2)]"]').length).toBe(0)
    expect(container.querySelectorAll('.h-2').length).toBe(1)
    expect(container.textContent).toContain('first line')
    expect(container.textContent).toContain('new paragraph')
  })
})
