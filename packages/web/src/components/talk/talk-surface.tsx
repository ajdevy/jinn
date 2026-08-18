import { useEffect, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { OrbState, OrbVariant } from "./orb-motion"
import { bindTalkActionLog } from "./talk-action-log"
import { TalkOrb } from "./talk-orb"

interface TalkSurfaceProps {
  state?: OrbState
  variant?: OrbVariant
  levelRef?: RefObject<number>
  /** The durable Talk session that owns any browser-side action receipts. */
  sessionId?: string | null
  /** Whether the realtime provider and microphone are attached. */
  active?: boolean
  label?: string
  onToggle?: () => void
}

/**
 * Aurora is the whole Talk surface. It is portalled to the body so it remains
 * draggable across routes and overlays, but Talk never mounts a parallel card,
 * sheet, text transcript, preview, or undo strip beside it.
 */
export function TalkSurface({
  state = "idle",
  variant = "mist",
  levelRef,
  sessionId = null,
  active = false,
  label,
  onToggle,
}: TalkSurfaceProps) {
  useEffect(() => {
    bindTalkActionLog(sessionId)
    return () => bindTalkActionLog(null)
  }, [sessionId])

  return createPortal(
    <TalkOrb variant={variant} state={state} levelRef={levelRef} active={active} label={label} onToggle={onToggle} />,
    document.body,
  )
}
