import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import {
  MIN_ZOOM,
  clampZoom,
  midpoint,
  panAroundPoint,
  pointDistance,
  type Point,
} from "@/lib/zoom-pan"

/**
 * Zooming and panning a picture in the preview. The arithmetic is in
 * `lib/zoom-pan`; what is here is the gesture state that feeds it.
 *
 * At fit, a single pointer is deliberately left alone: that is the surface's
 * drag-to-close, and only a picture with somewhere to go takes the pointer for
 * panning instead.
 */

/** What a double-click and the zoom control step to, and back from. */
const TOGGLE_ZOOM = 2

/** How fast a trackpad pinch travels. Small enough that the range is reachable. */
const WHEEL_SENSITIVITY = 0.002

/** Zoom and pan move together, so they are one value and never disagree. */
interface View {
  zoom: number
  pan: Point
}

const FIT: View = { zoom: MIN_ZOOM, pan: { x: 0, y: 0 } }

type Gesture =
  | { kind: "pan"; pointerId: number; startPoint: Point; startPan: Point }
  | {
      kind: "pinch"
      pointerIds: [number, number]
      startDistance: number
      startMidpoint: Point
      start: View
      imageCenter: Point
    }

type Pointers = Map<number, Point>

function pointOf(event: ReactPointerEvent): Point {
  return { x: event.clientX, y: event.clientY }
}

function centerOf(element: Element): Point {
  const bounds = element.getBoundingClientRect()
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
}

/** Two fingers pinch; one finger pans, but only once there is room to pan in. */
function beginGesture(event: ReactPointerEvent<HTMLElement>, pointers: Pointers, view: View): Gesture | null {
  const active = [...pointers.entries()]
  if (active.length >= 2) {
    const [[firstId, first], [secondId, second]] = active
    return {
      kind: "pinch",
      pointerIds: [firstId, secondId],
      startDistance: Math.max(1, pointDistance(first, second)),
      startMidpoint: midpoint(first, second),
      start: view,
      imageCenter: centerOf(event.currentTarget),
    }
  }
  if (view.zoom === MIN_ZOOM) return null
  return { kind: "pan", pointerId: event.pointerId, startPoint: pointOf(event), startPan: view.pan }
}

function pinchTo(gesture: Extract<Gesture, { kind: "pinch" }>, pointers: Pointers): View | null {
  const first = pointers.get(gesture.pointerIds[0])
  const second = pointers.get(gesture.pointerIds[1])
  if (!first || !second) return null
  const zoom = clampZoom((gesture.start.zoom * pointDistance(first, second)) / gesture.startDistance)
  return {
    zoom,
    pan: panAroundPoint({
      startPan: gesture.start.pan,
      startZoom: gesture.start.zoom,
      nextZoom: zoom,
      startPoint: gesture.startMidpoint,
      nextPoint: midpoint(first, second),
      imageCenter: gesture.imageCenter,
    }),
  }
}

function moveGesture(
  gesture: Gesture,
  pointers: Pointers,
  event: ReactPointerEvent<HTMLElement>,
  zoom: number,
): View | null {
  if (gesture.kind === "pinch") return pinchTo(gesture, pointers)
  if (gesture.pointerId !== event.pointerId) return null
  return {
    zoom,
    pan: {
      x: gesture.startPan.x + event.clientX - gesture.startPoint.x,
      y: gesture.startPan.y + event.clientY - gesture.startPoint.y,
    },
  }
}

/** Non-passive, because ctrl+wheel is the browser's own page zoom otherwise. */
function useWheelZoom(
  mediaRef: RefObject<HTMLImageElement | null>,
  view: View,
  setView: (next: View) => void,
): void {
  useEffect(() => {
    const element = mediaRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const point = { x: event.clientX, y: event.clientY }
      const zoom = clampZoom(view.zoom * Math.exp(-event.deltaY * WHEEL_SENSITIVITY))
      setView({
        zoom,
        pan: panAroundPoint({
          startPan: view.pan,
          startZoom: view.zoom,
          nextZoom: zoom,
          startPoint: point,
          nextPoint: point,
          imageCenter: centerOf(element),
        }),
      })
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [mediaRef, view, setView])
}

export interface ZoomPan {
  zoom: number
  pan: Point
  panning: boolean
  toggleZoom: () => void
  /** The picture itself: the wheel has to be listened to non-passively. */
  mediaRef: RefObject<HTMLImageElement | null>
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  }
}

interface GestureSink {
  view: View
  setView: (next: View) => void
  pointers: Pointers
  gesture: RefObject<Gesture | null>
  setPanning: (value: boolean) => void
}

function gestureHandlers({ view, setView, pointers, gesture, setPanning }: GestureSink): ZoomPan["handlers"] {
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    pointers.delete(event.pointerId)
    gesture.current = null
    setPanning(false)
  }

  return {
    onPointerDown(event) {
      pointers.set(event.pointerId, pointOf(event))
      const started = beginGesture(event, pointers, view)
      gesture.current = started
      if (!started) return
      if (started.kind === "pinch") {
        event.preventDefault()
        return
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setPanning(true)
    },
    onPointerMove(event) {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, pointOf(event))
      if (!gesture.current) return
      const next = moveGesture(gesture.current, pointers, event, view.zoom)
      if (next) setView(next)
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
}

/** `resetKey` is whatever identifies the picture: a new one starts back at fit. */
export function useZoomPan(resetKey: string): ZoomPan {
  const [view, setView] = useState<View>(FIT)
  const [panning, setPanning] = useState(false)
  const mediaRef = useRef<HTMLImageElement | null>(null)
  const pointers = useRef<Pointers>(new Map())
  const gesture = useRef<Gesture | null>(null)

  useEffect(() => {
    setView(FIT)
    setPanning(false)
    pointers.current.clear()
    gesture.current = null
  }, [resetKey])

  useWheelZoom(mediaRef, view, setView)

  const toggleZoom = useCallback(() => {
    setView((current) =>
      current.zoom === MIN_ZOOM ? { zoom: TOGGLE_ZOOM, pan: { x: 0, y: 0 } } : FIT,
    )
  }, [])

  return {
    zoom: view.zoom,
    pan: view.pan,
    panning,
    toggleZoom,
    mediaRef,
    handlers: gestureHandlers({ view, setView, pointers: pointers.current, gesture, setPanning }),
  }
}
