import { useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react'
import { usePrefersReducedMotion } from '@/components/talk/use-reduced-motion'

const POSITION_EPSILON = 0.5
const SESSION_SEPARATOR = '\u0000'

type MotionKind = 'add' | 'remove' | 'reorder'
type PaneNode = HTMLElement & { dataset: DOMStringMap & { gridMotion?: string } }
type PaneNodes = Map<string, PaneNode>

interface MotionMemory {
  ids: string[] | null
  rects: Map<string, DOMRect>
  animations: Animation[]
}

function tokenValue(node: HTMLElement, name: string): string {
  return getComputedStyle(node).getPropertyValue(name).trim()
    || getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function tokenMilliseconds(node: HTMLElement, name: string): number | null {
  const raw = tokenValue(node, name)
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return null
  return raw.endsWith('s') && !raw.endsWith('ms') ? value * 1000 : value
}

function motionKind(previous: readonly string[], next: readonly string[]): MotionKind {
  if (next.length > previous.length) return 'add'
  if (next.length < previous.length) return 'remove'
  return 'reorder'
}

function clearMotion(node: PaneNode): void {
  node.style.removeProperty('will-change')
  node.dataset.gridMotion = 'idle'
}

function clearGridEvidence(grid: HTMLDivElement | null): void {
  if (!grid) return
  delete grid.dataset.chatGridMotion
  delete grid.dataset.chatGridMotionDuration
}

/** The inverse transform that holds a pane at its pre-layout visual rectangle. */
export function paneFlipTransform(from: DOMRect, to: DOMRect): string | null {
  if (to.width <= 0 || to.height <= 0) return null
  const dx = from.left - to.left
  const dy = from.top - to.top
  const scaleX = from.width / to.width
  const scaleY = from.height / to.height
  const moved = Math.abs(dx) > POSITION_EPSILON || Math.abs(dy) > POSITION_EPSILON
  const resized = Math.abs(scaleX - 1) > 0.005 || Math.abs(scaleY - 1) > 0.005
  if (!moved && !resized) return null
  return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
}

function activePaneNodes(ids: readonly string[], nodes: PaneNodes): PaneNodes {
  return new Map(ids.flatMap((id) => {
    const node = nodes.get(id)
    return node ? [[id, node] as const] : []
  }))
}

function measurePaneNodes(nodes: PaneNodes): Map<string, DOMRect> {
  return new Map(Array.from(nodes, ([id, node]) => [id, node.getBoundingClientRect()] as const))
}

function animateSurvivors(
  nodes: PaneNodes,
  previousRects: Map<string, DOMRect>,
  nextRects: Map<string, DOMRect>,
  duration: number,
  easing: string,
): Animation[] {
  const animations: Animation[] = []
  nodes.forEach((node, id) => {
    const previous = previousRects.get(id)
    if (!previous || typeof node.animate !== 'function') return
    const transform = paneFlipTransform(previous, nextRects.get(id)!)
    if (!transform) return
    node.style.willChange = 'transform, opacity'
    node.dataset.gridMotion = 'settling'
    animations.push(node.animate(
      [{ transform, opacity: 1 }, { transform: 'none', opacity: 1 }],
      { duration, easing },
    ))
  })
  return animations
}

function endMotionPass(grid: HTMLDivElement, nodes: PaneNodes): void {
  nodes.forEach(clearMotion)
  clearGridEvidence(grid)
}

interface MotionPassArgs {
  grid: HTMLDivElement | null
  ids: string[]
  nodes: PaneNodes
  reduceMotion: boolean
  memory: MotionMemory
}

function runMotionPass({ grid, ids, nodes, reduceMotion, memory }: MotionPassArgs): (() => void) | undefined {
  const activeNodes = activePaneNodes(ids, nodes)
  const nextRects = measurePaneNodes(activeNodes)
  const previousIds = memory.ids
  const previousRects = memory.rects
  memory.ids = ids
  memory.rects = nextRects
  memory.animations.forEach((animation) => animation.cancel())
  memory.animations = []
  activeNodes.forEach(clearMotion)
  clearGridEvidence(grid)
  if (!previousIds || previousIds.join(SESSION_SEPARATOR) === ids.join(SESSION_SEPARATOR) || reduceMotion || !grid) return

  const duration = tokenMilliseconds(grid, '--duration-slow')
  const easing = tokenValue(grid, '--ease-snappy')
  if (duration === null || duration <= 0 || !easing) return
  const pass = animateSurvivors(activeNodes, previousRects, nextRects, duration, easing)
  if (pass.length === 0) return

  memory.animations = pass
  grid.dataset.chatGridMotion = motionKind(previousIds, ids)
  grid.dataset.chatGridMotionDuration = String(duration)
  void Promise.allSettled(pass.map((animation) => animation.finished)).then(() => {
    if (memory.animations !== pass) return
    memory.animations = []
    endMotionPass(grid, activeNodes)
  })
  return () => {
    pass.forEach((animation) => animation.cancel())
    if (memory.animations === pass) memory.animations = []
    endMotionPass(grid, activeNodes)
  }
}

interface GridMotion {
  gridRef: RefObject<HTMLDivElement | null>
  paneRef: (sessionId: string) => RefCallback<HTMLElement>
}

/** Session ids stay React keys; FLIP changes paint, never live-pane identity. */
export function useChatGridMotion(sessionIds: readonly string[]): GridMotion {
  const reduceMotion = usePrefersReducedMotion()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const nodesRef = useRef<PaneNodes>(new Map())
  const memoryRef = useRef<MotionMemory>({ ids: null, rects: new Map(), animations: [] })
  const callbacksRef = useRef(new Map<string, RefCallback<HTMLElement>>())
  const signature = sessionIds.join(SESSION_SEPARATOR)

  const paneRef = useCallback((sessionId: string): RefCallback<HTMLElement> => {
    const existing = callbacksRef.current.get(sessionId)
    if (existing) return existing
    const callback: RefCallback<HTMLElement> = (node) => {
      if (node) nodesRef.current.set(sessionId, node as PaneNode)
      else nodesRef.current.delete(sessionId)
    }
    callbacksRef.current.set(sessionId, callback)
    return callback
  }, [])

  useLayoutEffect(() => runMotionPass({
    grid: gridRef.current,
    ids: signature ? signature.split(SESSION_SEPARATOR) : [],
    nodes: nodesRef.current,
    reduceMotion,
    memory: memoryRef.current,
  }), [reduceMotion, signature])

  return { gridRef, paneRef }
}
