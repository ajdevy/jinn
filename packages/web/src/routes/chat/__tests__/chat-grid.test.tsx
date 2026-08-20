import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatGrid } from '../chat-grid'

const rect = (left: number, top: number, width = 100, height = 100): DOMRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--duration-slow')
  document.documentElement.style.removeProperty('--ease-snappy')
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
})

interface RecordedAnimation {
  target: HTMLElement
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  animation: Animation
  finish: () => void
}

function stubAnimations(): RecordedAnimation[] {
  const records: RecordedAnimation[] = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      let finish = () => {}
      const finished = new Promise<void>((resolve) => { finish = resolve })
      const animation = {
        cancel: vi.fn(),
        currentTime: 0,
        finished,
        pause: vi.fn(),
      } as unknown as Animation
      records.push({ target: this, keyframes: Array.from(frames), options, animation, finish })
      return animation
    },
  })
  return records
}

function installMotionTokens(): void {
  document.documentElement.style.setProperty('--duration-slow', '260ms')
  document.documentElement.style.setProperty('--ease-snappy', 'cubic-bezier(0.2,0,0,1)')
}

describe('live chat grid', () => {
  it('mounts four stable panes, focuses one, and removes only through its X', () => {
    const onFocus = vi.fn()
    const onRemove = vi.fn()
    const { rerender } = render(
      <ChatGrid
        sessionIds={['a', 'b', 'c', 'd']}
        focusedId="c"
        width={1440}
        height={900}
        onFocus={onFocus}
        onRemove={onRemove}
        renderPane={(id, active) => <output data-testid={`content-${id}`} data-active={String(active)} />}
      />,
    )

    const streamingNode = screen.getByTestId('pane-c')
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(4)
    expect(screen.getByTestId('content-c').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('chat-grid').getAttribute('data-columns')).toBe('2')
    expect(screen.getByRole('button', { name: 'Close d' }).className).toContain('top-[58px]')

    fireEvent.click(screen.getByTestId('pane-b'))
    expect(onFocus).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: 'Close b' }))
    expect(onRemove).toHaveBeenCalledWith('b')

    rerender(
      <ChatGrid
        sessionIds={['a', 'c', 'd']}
        focusedId="c"
        width={1440}
        height={900}
        onFocus={onFocus}
        onRemove={onRemove}
        renderPane={(id, active) => <output data-testid={`content-${id}`} data-active={String(active)} />}
      />,
    )
    expect(screen.getByTestId('pane-c')).toBe(streamingNode)
  })

  it('renders one pane without grid chrome', () => {
    render(
      <ChatGrid
        sessionIds={['only']}
        focusedId="only"
        width={1440}
        height={900}
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        renderPane={() => <output>Only pane</output>}
      />,
    )

    expect(screen.getByTestId('chat-grid').getAttribute('data-single-pane')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Close only' })).toBeNull()
  })

  it('FLIPs removal through transform and opacity while retaining pane nodes', () => {
    let layout = 0
    const animations = stubAnimations()
    installMotionTokens()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-testid')?.replace('pane-', '')
      if (layout === 0) return ({ a: rect(0, 0), b: rect(100, 0), c: rect(0, 100), d: rect(100, 100) } as Record<string, DOMRect>)[id ?? ''] ?? rect(0, 0, 0, 0)
      return ({ a: rect(0, 0), c: rect(100, 0), d: rect(200, 0) } as Record<string, DOMRect>)[id ?? ''] ?? rect(0, 0, 0, 0)
    })

    const view = (ids: string[]) => (
      <ChatGrid
        sessionIds={ids}
        focusedId="c"
        width={1440}
        height={900}
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        renderPane={(id) => <output data-testid={`content-${id}`} />}
      />
    )
    const { rerender } = render(view(['a', 'b', 'c', 'd']))
    const streamingPane = screen.getByTestId('pane-c')

    layout = 1
    rerender(view(['a', 'c', 'd']))

    expect(screen.getByTestId('pane-c')).toBe(streamingPane)
    expect(streamingPane.dataset.gridMotion).toBe('settling')
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBe('remove')
    const cMotion = animations.find((record) => record.target === streamingPane)!
    expect(cMotion.keyframes[0]?.transform).toContain('translate(-100px, 100px)')
    expect(cMotion.keyframes[1]).toEqual({ transform: 'none', opacity: 1 })
    expect(cMotion.options).toMatchObject({ duration: 260, easing: 'cubic-bezier(0.2,0,0,1)' })
    for (const frame of cMotion.keyframes) {
      expect(Object.keys(frame).filter((key) => key !== 'offset').every((key) => key === 'transform' || key === 'opacity')).toBe(true)
    }
  })

  it('keeps an add pass holdable at its exact midpoint for screenshot evidence', async () => {
    let layout = 0
    const animations = stubAnimations()
    installMotionTokens()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-testid')?.replace('pane-', '')
      if (layout === 0) return id === 'a' ? rect(0, 0, 200, 100) : rect(0, 0, 0, 0)
      return id === 'a' ? rect(0, 0) : id === 'b' ? rect(100, 0) : rect(0, 0, 0, 0)
    })
    const view = (ids: string[]) => (
      <ChatGrid sessionIds={ids} focusedId="a" width={1440} height={900} onFocus={vi.fn()} onRemove={vi.fn()} renderPane={(id) => <output>{id}</output>} />
    )
    const { rerender } = render(view(['a']))
    const original = screen.getByTestId('pane-a')
    layout = 1
    rerender(view(['a', 'b']))

    expect(screen.getByTestId('pane-a')).toBe(original)
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBe('add')
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotionDuration).toBe('260')
    expect(animations).toHaveLength(1)
    animations[0].animation.currentTime = 130
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBe('add')

    animations[0].finish()
    await waitFor(() => expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBeUndefined())
  })

  it('FLIPs reorder without replacing any pane', () => {
    let layout = 0
    const animations = stubAnimations()
    installMotionTokens()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-testid')?.replace('pane-', '')
      const order = layout === 0 ? ['a', 'b', 'c'] : ['c', 'a', 'b']
      return rect(order.indexOf(id ?? '') * 100, 0)
    })
    const view = (ids: string[]) => (
      <ChatGrid sessionIds={ids} focusedId="a" width={1440} height={900} onFocus={vi.fn()} onRemove={vi.fn()} renderPane={(id) => <output>{id}</output>} />
    )
    const { rerender } = render(view(['a', 'b', 'c']))
    const nodes = new Map(['a', 'b', 'c'].map((id) => [id, screen.getByTestId(`pane-${id}`)]))
    layout = 1
    rerender(view(['c', 'a', 'b']))

    for (const [id, node] of nodes) expect(screen.getByTestId(`pane-${id}`)).toBe(node)
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBe('reorder')
    expect(animations).toHaveLength(3)
  })

  it('cuts immediately under reduced motion instead of scheduling a shorter animation', () => {
    const requestFrame = vi.fn()
    const animations = stubAnimations()
    installMotionTokens()
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0))

    const view = (ids: string[]) => (
      <ChatGrid
        sessionIds={ids}
        focusedId="a"
        width={1440}
        height={900}
        onFocus={vi.fn()}
        onRemove={vi.fn()}
        renderPane={(id) => <output>{id}</output>}
      />
    )
    const { rerender } = render(view(['a']))
    const original = screen.getByTestId('pane-a')
    rerender(view(['a', 'b']))

    expect(screen.getByTestId('pane-a')).toBe(original)
    expect(screen.getByTestId('pane-a').dataset.gridMotion).toBe('idle')
    expect(screen.getByTestId('chat-grid').dataset.chatGridMotion).toBeUndefined()
    expect(animations).toHaveLength(0)
    expect(requestFrame).not.toHaveBeenCalled()
  })
})
