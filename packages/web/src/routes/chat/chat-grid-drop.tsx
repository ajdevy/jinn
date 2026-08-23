import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import {
  activeChatSessionDrag,
  clearChatSessionDrag,
  hasChatSessionDrag,
  isComposerDropTarget,
  readChatSessionDrop,
} from './chat-session-dnd'
import { cellRectForIndex } from './grid-cells'
import { workingSetIndexForGridSlot } from './grid-drop-target'
import { overflowForViewport } from './grid-layout'
import { deriveChatGridIds, placementForPointer, type GridPlacement } from './grid-placement'
import { insertWorkingSetSession, type ChatWorkingSet } from './working-set'

type DropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>
export interface ChatSessionDropState { active: boolean; placement: GridPlacement | null; handlers: DropHandlers }

export interface ChatSessionDropContext {
  workingSet: ChatWorkingSet
  cap: number
  primaryPaneKey: string
  committedSessionId: string | null
  pickerPaneKey: string | null
  viewport: { width: number; height: number }
}

export interface ChatGridDropProjection {
  insertionIndex: number
  nextWorkingSet: ChatWorkingSet
  gridPaneKeys: string[]
  droppedPaneIndex: number
}

function eligibleDrop(event: DragEvent): boolean {
  return hasChatSessionDrag(event.dataTransfer) && !isComposerDropTarget(event.target)
}

function pointerInside(node: HTMLElement, x: number, y: number): boolean {
  const rect = node.getBoundingClientRect()
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

export function simulateChatGridDrop(
  sessionId: string,
  domSlot: number,
  paneKeys: readonly string[],
  context: ChatSessionDropContext,
): ChatGridDropProjection {
  const insertionIndex = workingSetIndexForGridSlot(domSlot, {
    workingSet: context.workingSet,
    paneKeys,
    primaryPaneKey: context.primaryPaneKey,
    committedSessionId: context.committedSessionId,
    pickerPaneKey: context.pickerPaneKey,
  })
  const nextWorkingSet = insertWorkingSetSession(
    context.workingSet,
    sessionId,
    insertionIndex,
    context.cap,
  )
  const visible = overflowForViewport(
    nextWorkingSet,
    context.viewport.width,
    context.viewport.height,
    Number(Boolean(context.pickerPaneKey)),
  ).visible.sessionIds
  const gridPaneKeys = deriveChatGridIds({
    sessionIds: visible,
    primaryPaneKey: sessionId,
    primarySessionId: sessionId,
    pickerPaneKey: context.pickerPaneKey,
  })
  return {
    insertionIndex,
    nextWorkingSet,
    gridPaneKeys,
    droppedPaneIndex: gridPaneKeys.indexOf(sessionId),
  }
}

function measurePlacement(
  event: DragEvent,
  sessionId: string,
  context: ChatSessionDropContext,
): GridPlacement | null {
  const grid = event.currentTarget.querySelector<HTMLElement>('[data-testid="chat-grid"]')
  if (!grid) return null
  const panes = Array.from(grid.querySelectorAll<HTMLElement>('[data-chat-grid-pane]'))
  const gridRect = grid.getBoundingClientRect()
  const hit = placementForPointer(
    { x: event.clientX, y: event.clientY },
    panes.map((pane) => pane.getBoundingClientRect()),
    gridRect,
  )
  if (!hit) return null
  const projection = simulateChatGridDrop(
    sessionId,
    hit.targetIndex,
    panes.map((pane) => pane.dataset.chatGridPane ?? ''),
    context,
  )
  if (projection.droppedPaneIndex < 0) return null
  const spacing = Number.parseFloat(getComputedStyle(grid).getPropertyValue('--space-2')) || 0
  return {
    targetIndex: projection.insertionIndex,
    region: hit.region,
    previewRect: cellRectForIndex(
      projection.droppedPaneIndex,
      projection.gridPaneKeys.length,
      gridRect,
      { w: context.viewport.width, h: context.viewport.height },
      { padding: spacing, gap: spacing },
    ),
  }
}

function appendIndex(event: DragEvent, context: ChatSessionDropContext): number {
  const paneKeys = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-chat-grid-pane]'))
    .map((pane) => pane.dataset.chatGridPane ?? '')
  return workingSetIndexForGridSlot(paneKeys.length, {
    workingSet: context.workingSet,
    paneKeys,
    primaryPaneKey: context.primaryPaneKey,
    committedSessionId: context.committedSessionId,
    pickerPaneKey: context.pickerPaneKey,
  })
}

function useDragEndClear(active: boolean, clear: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
    window.addEventListener('dragend', clear)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active, clear])
}

interface DropHandlerDeps {
  context: ChatSessionDropContext
  onInsert: (sessionId: string, index: number) => void
  clearOverlay: () => void
  finishDrag: () => void
  depthRef: { current: number }
  placementRef: { current: GridPlacement | null }
  setActive: (value: boolean) => void
  setPlacement: (value: GridPlacement | null) => void
}

function updatePlacement(event: DragEvent, deps: DropHandlerDeps): GridPlacement | null {
  const sessionId = readChatSessionDrop(event.dataTransfer) ?? activeChatSessionDrag()
  const next = sessionId ? measurePlacement(event, sessionId, deps.context) : null
  deps.placementRef.current = next
  deps.setPlacement(next)
  return next
}

function createDropHandlers(deps: DropHandlerDeps): DropHandlers {
  return {
    onDragEnter: (event) => {
      if (hasChatSessionDrag(event.dataTransfer) && isComposerDropTarget(event.target)) {
        deps.clearOverlay()
        return
      }
      if (!eligibleDrop(event)) return
      event.preventDefault()
      deps.depthRef.current += 1
      deps.setActive(true)
      updatePlacement(event, deps)
    },
    onDragLeave: (event) => {
      if (!hasChatSessionDrag(event.dataTransfer)) return
      deps.depthRef.current = Math.max(0, deps.depthRef.current - 1)
      if (deps.depthRef.current === 0 && !pointerInside(event.currentTarget, event.clientX, event.clientY)) {
        deps.clearOverlay()
      }
    },
    onDragOver: (event) => {
      if (!eligibleDrop(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      deps.setActive(Boolean(updatePlacement(event, deps)))
    },
    onDrop: (event) => {
      if (!eligibleDrop(event)) return
      const sessionId = readChatSessionDrop(event.dataTransfer)
      const targetIndex = deps.placementRef.current?.targetIndex ?? appendIndex(event, deps.context)
      deps.finishDrag()
      if (!sessionId) return
      event.preventDefault()
      event.stopPropagation()
      deps.onInsert(sessionId, targetIndex)
    },
  }
}

export function useChatSessionDrop(
  onInsert: (sessionId: string, index: number) => void,
  context: ChatSessionDropContext,
): ChatSessionDropState {
  const [active, setActive] = useState(false)
  const [placement, setPlacement] = useState<GridPlacement | null>(null)
  const placementRef = useRef<GridPlacement | null>(null)
  const depthRef = useRef(0)
  const clearOverlay = useCallback(() => {
    depthRef.current = 0
    placementRef.current = null
    setPlacement(null)
    setActive(false)
  }, [])

  const finishDrag = useCallback(() => {
    clearOverlay()
    clearChatSessionDrag()
  }, [clearOverlay])

  useDragEndClear(active, finishDrag)

  const handlers = useMemo<DropHandlers>(() => createDropHandlers({
    context,
    onInsert,
    clearOverlay,
    finishDrag,
    depthRef,
    placementRef,
    setActive,
    setPlacement,
  }), [clearOverlay, context, finishDrag, onInsert])

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
      className="pointer-events-none fixed left-0 top-0 z-30 rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_18%,var(--bg-secondary))] opacity-100 shadow-[var(--shadow-card)]"
      style={{
        width: previewRect.width,
        height: previewRect.height,
        transform: `translate3d(${previewRect.left}px, ${previewRect.top}px, 0)`,
      }}
    />
  )
}
