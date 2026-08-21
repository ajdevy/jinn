import { describe, expect, it, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { ChatHeaderPills } from '../chat-tabs'

const noop = () => {}
const entering = (container: HTMLElement) => container.querySelectorAll('[data-title-enter]')

function header(title: string) {
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} />
}

/** The working set replaces the centred title with four chips. */
function headerWithChips(title: string) {
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} mobileWorkingSet={<nav />} />
}

describe('chat title entrance', () => {
  const realMatchMedia = window.matchMedia
  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { value: realMatchMedia, writable: true, configurable: true })
  })

  it('leaves the title a header opens with unmarked', () => {
    const { container } = render(header('Release plan'))
    expect(entering(container)).toHaveLength(0)
  })

  it('leaves a rerender that changes nothing unmarked', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Release plan'))
    expect(entering(container)).toHaveLength(0)
  })

  it('marks the nav-bar title when the conversation changes under it', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    const marked = entering(container)
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe('Weekly digest')
  })

  it('leaves the desktop title alone', () => {
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    // Both breakpoints render into jsdom; only the centred nav-bar title, which
    // has no desktop equivalent to reflow, carries the mark.
    expect(entering(container)).toHaveLength(1)
    expect(container.querySelectorAll('.truncate[data-title-enter]')).toHaveLength(1)
  })

  it('does not replay an entrance the reader already watched, on remount', () => {
    const first = render(header('Release plan'))
    first.rerender(header('Weekly digest'))
    expect(entering(first.container)).toHaveLength(1)
    first.unmount()

    const second = render(header('Weekly digest'))
    expect(entering(second.container)).toHaveLength(0)
  })

  it('does not animate a swap that happened behind the working-set chips', () => {
    const { container, rerender } = render(headerWithChips('Release plan'))
    rerender(headerWithChips('Weekly digest'))
    // Well inside the mark's TTL: the span comes back carrying a title that
    // changed while nobody could see it, which is a mount, not an arrival.
    rerender(header('Weekly digest'))
    expect(entering(container)).toHaveLength(0)
  })

  it('still animates the next real change once the title is back on screen', () => {
    const { container, rerender } = render(headerWithChips('Release plan'))
    rerender(header('Release plan'))
    expect(entering(container)).toHaveLength(0)
    rerender(header('Weekly digest'))
    expect(entering(container)).toHaveLength(1)
  })

  it('marks nothing under reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true, configurable: true,
      value: (media: string) => ({
        matches: true, media,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
        onchange: null, dispatchEvent: () => false,
      }),
    })
    const { container, rerender } = render(header('Release plan'))
    rerender(header('Weekly digest'))
    expect(entering(container)).toHaveLength(0)
  })
})
