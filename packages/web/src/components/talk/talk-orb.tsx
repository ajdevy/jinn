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
import { SILENT_ENERGY, type OrbEnergy, type OrbState, type OrbVariant } from "./orb-motion"
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

/** Past this much travel a press was a drag, and a drag must not start a voice
 *  session. Under it, a press that wobbled is still a tap. */
const DRAG_SLOP_PX = 5

interface DragState {
  pointerId: number
  startX: number
  startY: number
  /** Where the sphere's centre sat when the drag began. */
  centreX: number
  centreY: number
}

/** Anchor a drag to the pointer and to where the sphere's centre sat when it
 *  began, which is what a release is measured against. */
function beginDrag(event: ReactPointerEvent<HTMLElement>): DragState {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    centreX: rect.left + rect.width / 2,
    centreY: rect.top + rect.height / 2,
  }
}

/** Where the sphere's centre ended up, and the corner it therefore belongs in. */
function releasedCorner(drag: DragState, event: ReactPointerEvent): ParkCorner {
  const centre = {
    x: drag.centreX + event.clientX - drag.startX,
    y: drag.centreY + event.clientY - drag.startY,
  }
  return nearestCorner(centre, { width: window.innerWidth, height: window.innerHeight })
}

/**
 * Drag by `transform` — never by re-laying-out the corner — and snap to the
 * nearest corner on release, so the orb ends where the page expects it.
 *
 * `takeDragged` is what the click handler reads: the browser fires a click after
 * every pointer sequence, so moving the orb would otherwise also activate it.
 */
function useOrbDrag() {
  const [corner, setCorner] = useState<ParkCorner>(readPark)
  const [offset, setOffset] = useState<Point | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const draggedRef = useRef(false)

  const active = (event: ReactPointerEvent) =>
    dragRef.current?.pointerId === event.pointerId ? dragRef.current : null

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType !== "touch") return
    dragRef.current = beginDrag(event)
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
    draggedRef.current = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_SLOP_PX
    const next = releasedCorner(drag, event)
    writePark(next)
    setCorner(next)
  }

  const onPointerCancel = () => {
    dragRef.current = null
    setOffset(null)
  }

  /** True once per drag, and consumed by the click it has to swallow. */
  const takeDragged = () => {
    const dragged = draggedRef.current
    draggedRef.current = false
    return dragged
  }

  return { corner, offset, takeDragged, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } }
}

interface TalkOrbProps {
  /** What the orb is doing. Motion is the only channel — the orb carries no text. */
  state?: OrbState
  variant?: OrbVariant
  /** Live per-channel amplitude driving the lobes. Absent until something is
   *  talking. */
  energyRef?: RefObject<OrbEnergy>
  /** Where the sphere's centre should sit while a situation is open, in viewport
   *  px. Null flies it home. Applied as a transform, so the canvas keeps its own
   *  animation frame and never remounts. */
  dock?: Point | null
  /** Whether a voice session is open. Names the control for a screen reader and
   *  is what `aria-pressed` reports. */
  active?: boolean
  /** Accessible name for exceptional states whose next press is not the normal
   *  start/end action. Aurora still carries no visible text. */
  label?: string
  /** Start or end the voice session. Absent on a bench that drives the orb by
   *  hand, where the sphere is a control that does nothing. */
  onToggle?: () => void
}

interface Flight {
  offset: Point
  durationMs: number
  ease: string
}

/**
 * The transform that carries the sphere out to `dock` and back. Closing replays
 * the same pair of points reversed, which lands the offset back at zero.
 *
 * Park comes from the offset box rather than from `getBoundingClientRect`,
 * because the rect includes whatever transform is already applied and the corner
 * the sphere is anchored to moves when the viewport does. Measuring the rect
 * while docked reads the dock as the park, and the next flight is then plotted
 * from the wrong origin — which is how a sheet that reopens at another
 * breakpoint lands the sphere in the middle of its own controls. The overlay is
 * `fixed inset-0`, so these offsets are already viewport coordinates.
 */
function useDockFlight(dock: Point | null | undefined, host: RefObject<HTMLElement | null>): Flight | null {
  const [flight, setFlight] = useState<Flight | null>(null)
  const dockRef = useRef<Point | null>(null)

  useLayoutEffect(() => {
    const sphere = host.current
    if (!sphere) return
    if (dock) dockRef.current = dock
    const target = dockRef.current
    if (!target) return
    const park = {
      x: sphere.offsetLeft + sphere.offsetWidth / 2,
      y: sphere.offsetTop + sphere.offsetHeight / 2,
    }
    const path = dockPath(dock ? "open" : "close", park, target)
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
 *
 * It stacks above the situation sheet (`z-[90]`) and the app's other overlays,
 * because the sheet's scrim also covers the viewport: below it, hit testing would
 * hand every tap meant for the sphere to the scrim and the orb would go dead for
 * exactly as long as a decision is on screen.
 */
export function TalkOrb({ variant = "mist", state = "idle", energyRef, dock, active = false, label, onToggle }: TalkOrbProps) {
  const silent = useRef(SILENT_ENERGY)
  const sphereRef = useRef<HTMLButtonElement | null>(null)
  const { corner, offset, takeDragged, handlers } = useOrbDrag()
  const flight = useDockFlight(dock, sphereRef)
  const reduce = usePrefersReducedMotion()

  // A drag ends in a click too. Swallowing that one is what keeps moving the orb
  // out of the corner from also starting a paid voice session.
  const onClick = () => {
    if (takeDragged()) return
    onToggle?.()
  }

  return (
    <div data-talk-orb-overlay className="pointer-events-none fixed inset-0 z-[110]">
      <button
        ref={sphereRef}
        data-talk-orb
        data-orb-state={state}
        data-orb-variant={variant}
        type="button"
        aria-label={label ?? (active ? "End voice session" : "Start voice session")}
        aria-pressed={active}
        className={cn(
          "pointer-events-auto absolute cursor-grab touch-none overflow-hidden rounded-full",
          "appearance-none border-none bg-transparent p-0",
          "outline-none active:cursor-grabbing",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          CORNER_CLASS[corner],
        )}
        style={sphereStyle(offset, flight, reduce)}
        onClick={onClick}
        {...handlers}
      >
        <OrbCanvas variant={variant} state={state} energyRef={energyRef ?? silent} size={SPHERE_SIZE} />
      </button>
    </div>
  )
}
