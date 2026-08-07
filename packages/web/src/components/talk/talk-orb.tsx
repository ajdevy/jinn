import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { cn } from "@/lib/utils"
import { OrbCanvas } from "./orb-canvas"
import type { OrbState } from "./orb-motion"
import { nearestCorner, readPark, writePark, type ParkCorner, type Point } from "./orb-park"
import { dockPath } from "./situation-choreography"
import { usePrefersReducedMotion } from "./use-reduced-motion"

const SPHERE_SIZE = 64

/**
 * The bottom corners clear the mobile tab bar, then leave a 16px gap. The bar is
 * taller than its 49px tap target: `mobile-tab-bar.tsx` adds `py-1.5` on top and
 * `max(var(--safe-bottom), 6px)` below, so the 22px is that 6px plus the gap.
 * On `lg` there is no tab bar at all. Each class is spelled out because Tailwind
 * scans source text — a composed string would never be generated.
 */
const CORNER_CLASS: Record<ParkCorner, string> = {
  "top-left": "top-[calc(var(--safe-top)+16px)] left-[calc(var(--safe-left)+16px)]",
  "top-right": "top-[calc(var(--safe-top)+16px)] right-[calc(var(--safe-right)+16px)]",
  "bottom-left":
    "bottom-[calc(49px+max(var(--safe-bottom),6px)+22px)] left-[calc(var(--safe-left)+16px)] lg:bottom-5",
  "bottom-right":
    "bottom-[calc(49px+max(var(--safe-bottom),6px)+22px)] right-[calc(var(--safe-right)+16px)] lg:bottom-5",
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  /** Where the sphere's centre sat when the drag began. */
  centreX: number
  centreY: number
}

/**
 * Drag by `transform` — never by re-laying-out the corner — and snap to the
 * nearest corner on release, so the orb ends where the page expects it.
 */
function useOrbDrag() {
  const [corner, setCorner] = useState<ParkCorner>(readPark)
  const [offset, setOffset] = useState<Point | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const active = (event: ReactPointerEvent) =>
    dragRef.current?.pointerId === event.pointerId ? dragRef.current : null

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType !== "touch") return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centreX: rect.left + rect.width / 2,
      centreY: rect.top + rect.height / 2,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setOffset({ x: 0, y: 0 })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = active(event)
    if (!drag) return
    setOffset({ x: event.clientX - drag.startX, y: event.clientY - drag.startY })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = active(event)
    if (!drag) return
    dragRef.current = null
    setOffset(null)
    const centre = {
      x: drag.centreX + event.clientX - drag.startX,
      y: drag.centreY + event.clientY - drag.startY,
    }
    const next = nearestCorner(centre, { width: window.innerWidth, height: window.innerHeight })
    writePark(next)
    setCorner(next)
  }

  const onPointerCancel = () => {
    dragRef.current = null
    setOffset(null)
  }

  return { corner, offset, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } }
}

interface TalkOrbProps {
  /** What the orb is doing. Motion is the only channel — the orb carries no text. */
  state?: OrbState
  /** Live 0..1 amplitude driving the lobes. Absent until something is talking. */
  levelRef?: RefObject<number>
  /** Where the sphere's centre should sit while a situation is open, in viewport
   *  px. Null flies it home. Applied as a transform, so the canvas keeps its own
   *  animation frame and never remounts. */
  dock?: Point | null
}

interface Flight {
  offset: Point
  durationMs: number
  ease: string
}

/**
 * The transform that carries the sphere out to `dock` and back. Opening measures
 * the parked centre while no dock transform is applied; closing replays that
 * same pair of points reversed, which lands the offset back at zero.
 */
function useDockFlight(dock: Point | null | undefined, host: RefObject<HTMLElement | null>): Flight | null {
  const [flight, setFlight] = useState<Flight | null>(null)
  const parkRef = useRef<Point | null>(null)
  const dockRef = useRef<Point | null>(null)

  useLayoutEffect(() => {
    const sphere = host.current
    if (!sphere) return
    if (dock) {
      const rect = sphere.getBoundingClientRect()
      parkRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      dockRef.current = dock
    }
    const park = parkRef.current
    if (!park) return
    const path = dockPath(dock ? "open" : "close", park, dockRef.current ?? park)
    setFlight({
      offset: { x: path.to.x - park.x, y: path.to.y - park.y },
      durationMs: path.durationMs,
      ease: path.ease,
    })
  }, [dock, host])

  return flight
}

function translate(shift: Point | null | undefined): string | undefined {
  return shift ? `translate3d(${shift.x}px, ${shift.y}px, 0)` : undefined
}

function flightMs(flight: Flight | null, still: boolean): number {
  if (still || !flight) return 0
  return flight.durationMs
}

/** A drag follows the finger; only the flight to and from the dock eases. */
function sphereStyle(drag: Point | null, flight: Flight | null, reduce: boolean): CSSProperties {
  const still = drag !== null || reduce
  return {
    width: SPHERE_SIZE,
    height: SPHERE_SIZE,
    transform: translate(drag ?? flight?.offset),
    transitionProperty: drag ? "none" : "transform",
    transitionDuration: `${flightMs(flight, still)}ms`,
    transitionTimingFunction: flight?.ease,
  }
}

/**
 * The floating sphere. Its overlay covers the viewport so the orb can sit in any
 * corner, and takes no pointer events itself — only the sphere's own circle does.
 */
export function TalkOrb({ state = "idle", levelRef, dock }: TalkOrbProps) {
  const silent = useRef(0)
  const sphereRef = useRef<HTMLDivElement | null>(null)
  const { corner, offset, handlers } = useOrbDrag()
  const flight = useDockFlight(dock, sphereRef)
  const reduce = usePrefersReducedMotion()

  return (
    <div data-talk-orb-overlay className="pointer-events-none fixed inset-0 z-50">
      <div
        ref={sphereRef}
        data-talk-orb
        role="img"
        aria-label="Talk"
        className={cn(
          "pointer-events-auto absolute cursor-grab touch-none overflow-hidden rounded-full",
          "shadow-[var(--shadow-key)] active:cursor-grabbing",
          CORNER_CLASS[corner],
        )}
        style={sphereStyle(offset, flight, reduce)}
        {...handlers}
      >
        <OrbCanvas state={state} levelRef={levelRef ?? silent} size={SPHERE_SIZE} />
      </div>
    </div>
  )
}
