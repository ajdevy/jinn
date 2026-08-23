import { useCallback, useEffect, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { OrbEnergy, OrbState, OrbVariant } from "./orb-motion"
import { SituationSheet } from "./situation-sheet"
import { bindTalkActionLog } from "./talk-action-log"
import { TalkOrb } from "./talk-orb"
import { answerSituation, dismissSituation, useSituation } from "./talk-situation-store"

interface TalkSurfaceProps {
  state?: OrbState
  variant?: OrbVariant
  energyRef?: RefObject<OrbEnergy>
  /** The durable Talk session that owns any browser-side action receipts. */
  sessionId?: string | null
  /** Whether the realtime provider and microphone are attached. */
  active?: boolean
  label?: string
  onToggle?: () => void
}

/**
 * Aurora is the ambient Talk surface. It is portalled to the body so it remains
 * draggable across routes and overlays. An outward write can raise the existing
 * consent sheet here; no transcript, preview, or undo strip stays beside it.
 */
export function TalkSurface({
  state = "idle",
  variant = "mist",
  energyRef,
  sessionId = null,
  active = false,
  label,
  onToggle,
}: TalkSurfaceProps) {
  const situation = useSituation()

  useEffect(() => {
    bindTalkActionLog(sessionId)
    return () => bindTalkActionLog(null)
  }, [sessionId])

  const answer = useCallback((choiceId: string) => answerSituation(choiceId), [])

  return createPortal(
    <>
      <SituationSheet situation={situation} onAnswer={answer} onDismiss={dismissSituation} />
      <TalkOrb variant={variant} state={state} energyRef={energyRef} active={active} label={label} onToggle={onToggle} />
    </>,
    document.body,
  )
}
