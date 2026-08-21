import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import { hasChatSessionDrag, isComposerDropTarget, readChatSessionDrop } from './chat-session-dnd'
import { placementForPointer, type GridPlacement } from './grid-placement'

type DropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>
export interface ChatSessionDropState { active: boolean; placement: GridPlacement | null; handlers: DropHandlers }

function eligibleDrop(event: DragEvent): boolean {
  return hasChatSessionDrag(event.dataTransfer) && !isComposerDropTarget(event.target)
}

function measurePlacement(event: DragEvent): GridPlacement | null {
  const grid = event.currentTarget.querySelector<HTMLElement>('[data-testid="chat-grid"]')
  if (!grid) return null
  const paneRects = Array.from(grid.querySelectorAll<HTMLElement>('[data-chat-grid-pane]'))
    .map((pane) => pane.getBoundingClientRect())
  return placementForPointer(
    { x: event.clientX, y: event.clientY },
    paneRects,
    grid.getBoundingClientRect(),
  )
}

function appendIndex(event: DragEvent): number {
  return event.currentTarget.querySelectorAll('[data-chat-grid-pane]').length
}

function useDragEndClear(active: boolean, clear: () => void): void {
  useEffect(() => {
    if (!active) return
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [active, clear])
}

export function useChatSessionDrop(onInsert: (sessionId: string, index: number) => void): ChatSessionDropState {
  const [active, setActive] = useState(false)
  const [placement, setPlacement] = useState<GridPlacement | null>(null)
  const placementRef = useRef<GridPlacement | null>(null)
  const depthRef = useRef(0)
  const clear = useCallback(() => {
    depthRef.current = 0
    placementRef.current = null
    setPlacement(null)
    setActive(false)
  }, [])

  useDragEndClear(active, clear)

  const handlers = useMemo<DropHandlers>(() => ({
    onDragEnter: (event) => {
      if (!eligibleDrop(event)) return
      event.preventDefault()
      depthRef.current += 1
      setActive(true)
    },
    onDragLeave: (event) => {
      if (!hasChatSessionDrag(event.dataTransfer)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) clear()
    },
    onDragOver: (event) => {
      if (!eligibleDrop(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      const next = measurePlacement(event)
      placementRef.current = next
      setPlacement(next)
      setActive(Boolean(next))
    },
    onDrop: (event) => {
      if (!eligibleDrop(event)) return
      const sessionId = readChatSessionDrop(event.dataTransfer)
      const targetIndex = placementRef.current?.targetIndex ?? appendIndex(event)
      clear()
      if (!sessionId) return
      event.preventDefault()
      event.stopPropagation()
      onInsert(sessionId, targetIndex)
    },
  }), [clear, onInsert])

  return { active, placement, handlers }
}

export function ChatGridDropOverlay({ placement }: { placement: GridPlacement | null }) {
  if (!placement) return null
  const { previewRect } = placement
  return (
    <div
      data-testid="chat-grid-drop-zone"
      data-drop-region={placement.region}
      data-drop-index={placement.targetIndex}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-30 rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_18%,var(--bg-secondary))] opacity-100 shadow-[var(--shadow-card)] transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-standard)]"
      style={{
        width: previewRect.width,
        height: previewRect.height,
        transform: `translate3d(${previewRect.left}px, ${previewRect.top}px, 0)`,
      }}
    />
  )
}
