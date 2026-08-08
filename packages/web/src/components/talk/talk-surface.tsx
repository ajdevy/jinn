import { useCallback, useEffect, useMemo, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { closePreview } from "./media-preview-store"
import type { OrbState } from "./orb-motion"
import { readPark, type Point } from "./orb-park"
import { breakpointOf, dockPoint, type SheetRect } from "./situation-choreography"
import { SituationSheet } from "./situation-sheet"
import { bindTalkActionLog } from "./talk-action-log"
import { TalkOrb } from "./talk-orb"
import { answerSituation, dismissSituation, useSituation } from "./talk-situation-store"
import { UndoStrip } from "./undo-strip"

/**
 * Orb, sheet, and undo strip, as one surface. It is portalled to `document.body`
 * on purpose: the sheet deactivates `#root` while it is open, and the orb has to
 * stay live and draggable through the whole decision, which it cannot do from
 * inside it.
 *
 * The strip stands down while a sheet is on screen. On a phone the sheet owns
 * the whole bottom, which is where the strip sits, so one left up would be
 * buried under a modal and counting down where nobody could reach it. A null
 * layout box is what says the sheet has finished leaving; the offer keeps its
 * own window, so the strip comes back with whatever is left of it.
 */

interface TalkSurfaceProps {
  state?: OrbState
  levelRef?: RefObject<number>
  /** The open talk session, when there is one. It is what the action log posts
   *  the gateway's copy to, and this surface is where a session and the tools
   *  that write under it are both in scope. `talk-live-surface.tsx` opens one
   *  and the store hands it back down; null on a bench driving the orb by hand. */
  sessionId?: string | null
  /** Whether a voice session is open, and the control that starts or ends one.
   *  Absent on a bench, where the orb is driven by hand and starts nothing. */
  active?: boolean
  onToggle?: () => void
  /** Observes what the operator picked. The answer itself goes back through the
   *  store, which is what settles an awaited situation — a consent gate is
   *  reached from a tool executor, and there is no prop path from here to one. */
  onAnswer?: (situationId: string, choiceId: string) => void
}

/**
 * Where the orb should fly to while a situation is open. The sheet is up but
 * unmeasured for exactly one frame; until then the orb has nowhere to go, so it
 * stays parked rather than guessing at a dock point. Memoised because a fresh
 * point every render would restart the flight.
 */
function useDock(situation: unknown, sheetRect: SheetRect | null): Point | null {
  return useMemo<Point | null>(() => {
    if (!situation || !sheetRect) return null
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    return dockPoint(readPark(), sheetRect, viewport, breakpointOf(viewport))
  }, [situation, sheetRect])
}

export function TalkSurface({
  state = "idle",
  levelRef,
  sessionId = null,
  active = false,
  onToggle,
  onAnswer,
}: TalkSurfaceProps) {
  const situation = useSituation()
  const [sheetRect, setSheetRect] = useState<SheetRect | null>(null)

  // Unbound on the way out as well as in: entries posted against a session this
  // surface no longer owns would be an audit written under the wrong name.
  useEffect(() => {
    bindTalkActionLog(sessionId)
    return () => bindTalkActionLog(null)
  }, [sessionId])

  // Answering settles rather than dismisses: a decision that was made leaves
  // nothing behind to raise again.
  const answer = useCallback(
    (choiceId: string) => {
      if (situation) onAnswer?.(situation.id, choiceId)
      answerSituation(choiceId)
    },
    [situation, onAnswer],
  )

  // A preview belongs to the situation that raised it, so it goes when that does.
  useEffect(() => {
    if (!situation) closePreview()
  }, [situation])

  const dock = useDock(situation, sheetRect)

  return createPortal(
    <>
      <SituationSheet
        situation={situation}
        onAnswer={answer}
        onDismiss={dismissSituation}
        onLayout={setSheetRect}
      />
      {!situation && !sheetRect && <UndoStrip />}
      <TalkOrb state={state} levelRef={levelRef} dock={dock} active={active} onToggle={onToggle} />
    </>,
    document.body,
  )
}
