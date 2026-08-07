import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { dragOutcome, rubberBand } from "./sheet-drag"

/**
 * Throwing a surface away with a downward drag. One pointer path — no touch
 * branch, no mouse branch — so a finger, a trackpad and a pen produce the same
 * outcome from the same movement. The maths lives in `sheet-drag`; what is here
 * is the pointer bookkeeping and the capture that keeps the gesture alive after
 * the finger leaves the handle it started on.
 */

interface Drag {
  pointerId: number
  startY: number
  lastY: number
  lastAt: number
  velocityY: number
}

/**
 * Shorter than a frame, a sample is noise: one stray pixel over a fraction of a
 * millisecond reads as a flick nobody performed.
 */
const MIN_SAMPLE_MS = 8

interface DragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface SheetDrag {
  /** How far the surface should move, already rubber-banded. 0 when at rest. */
  offsetY: number
  dragging: boolean
  handlers: DragHandlers
}

/** Capture keeps the gesture alive once the finger leaves the handle. */
function startDrag(event: ReactPointerEvent<HTMLElement>): Drag {
  event.currentTarget.setPointerCapture?.(event.pointerId)
  return {
    pointerId: event.pointerId,
    startY: event.clientY,
    lastY: event.clientY,
    lastAt: performance.now(),
    velocityY: 0,
  }
}

function sampleVelocity(drag: Drag, clientY: number): void {
  const now = performance.now()
  const elapsed = now - drag.lastAt
  if (elapsed < MIN_SAMPLE_MS) return
  drag.velocityY = (clientY - drag.lastY) / elapsed
  drag.lastY = clientY
  drag.lastAt = now
}

interface DragSink {
  dragRef: RefObject<Drag | null>
  setOffsetY: (value: number) => void
  setDragging: (value: boolean) => void
  onDismiss: () => void
  enabled: boolean
}

function pointerHandlers({ dragRef, setOffsetY, setDragging, onDismiss, enabled }: DragSink): DragHandlers {
  const active = (event: ReactPointerEvent) =>
    dragRef.current?.pointerId === event.pointerId ? dragRef.current : null

  const release = () => {
    dragRef.current = null
    setDragging(false)
    setOffsetY(0)
  }

  return {
    onPointerDown(event) {
      if (!enabled || dragRef.current) return
      dragRef.current = startDrag(event)
      setDragging(true)
    },
    onPointerMove(event) {
      const drag = active(event)
      if (!drag) return
      sampleVelocity(drag, event.clientY)
      setOffsetY(rubberBand(event.clientY - drag.startY))
    },
    onPointerUp(event) {
      const drag = active(event)
      if (!drag) return
      const outcome = dragOutcome({
        offsetY: event.clientY - drag.startY,
        velocityY: drag.velocityY,
      })
      release()
      if (outcome === "dismiss") onDismiss()
    },
    onPointerCancel(event) {
      if (!active(event)) return
      release()
    },
  }
}

/**
 * `enabled` is how a surface that has its own gesture — a zoomed picture being
 * panned — keeps this one out of the way for as long as that gesture owns the
 * pointer.
 */
export function useSheetDrag(onDismiss: () => void, enabled = true): SheetDrag {
  const [offsetY, setOffsetY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<Drag | null>(null)

  return {
    offsetY,
    dragging,
    handlers: pointerHandlers({ dragRef, setOffsetY, setDragging, onDismiss, enabled }),
  }
}
