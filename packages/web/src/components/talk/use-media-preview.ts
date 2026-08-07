import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { closePreview, stepPreview, type OriginRect } from "./media-preview-store"

/**
 * How the preview arrives, and the keys that drive it once it is there.
 *
 * The entrance is a FLIP: the media is laid out where it will finish, measured,
 * then shown for one frame wearing the thumbnail's box before that transform is
 * taken away and the transition carries it home. So the picture appears to grow
 * out of the tile the operator tapped rather than cutting over it.
 */

/** `measuring` is the invisible frame at final geometry the FLIP is read from. */
export type PreviewPhase = "measuring" | "entering" | "open"

/** Two frames at 60Hz: long enough to have painted, short enough to feel instant. */
const ENTRANCE_BACKSTOP_MS = 32

/**
 * The transform that puts a laid-out stage back over its thumbnail. A stage with
 * no box yet has no shape to grow from, so the preview simply appears instead of
 * flying out of nothing.
 */
export function flipTransform(from: OriginRect, to: OriginRect): string | undefined {
  if (to.width <= 0 || to.height <= 0) return undefined
  const scale = from.width / to.width
  const shiftX = from.left + from.width / 2 - (to.left + to.width / 2)
  const shiftY = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate(${shiftX}px, ${shiftY}px) scale(${scale})`
}

/** Escape hands the sheet back; the arrows walk the set without leaving it. */
function usePreviewKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closePreview()
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        stepPreview(-1)
        return
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        stepPreview(1)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}

/** Focus goes into the preview, and back to the tile it was opened from. */
function useFocusHandover(panelRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const returnTo = document.activeElement
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true })
      }
    }
  }, [panelRef])
}

export interface PreviewEntrance {
  phase: PreviewPhase
  /** The thumbnail's box as a transform, for the one frame that wears it. */
  flip: string | undefined
  stageRef: RefObject<HTMLDivElement | null>
  panelRef: RefObject<HTMLDivElement | null>
}

export function useMediaPreview(origin: OriginRect | null, reduce: boolean): PreviewEntrance {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<PreviewPhase>("measuring")
  const [flip, setFlip] = useState<string | undefined>(undefined)

  usePreviewKeys()
  useFocusHandover(panelRef)

  // Reduced motion has no transform stage at all: the preview is simply there.
  useLayoutEffect(() => {
    if (phase !== "measuring") return
    const stage = stageRef.current
    if (reduce || !origin || !stage) {
      setPhase("open")
      return
    }
    setFlip(flipTransform(origin, stage.getBoundingClientRect()))
    setPhase("entering")
  }, [phase, origin, reduce])

  // A frame, so the browser paints the thumbnail-sized state the transition runs
  // from — plus a timer, because a backgrounded tab never fires the frame and the
  // preview would sit there wearing a stale transform.
  useEffect(() => {
    if (phase !== "entering") return
    const land = () => {
      setFlip(undefined)
      setPhase("open")
    }
    const frame = requestAnimationFrame(land)
    const backstop = setTimeout(land, ENTRANCE_BACKSTOP_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(backstop)
    }
  }, [phase])

  return { phase, flip, stageRef, panelRef }
}
