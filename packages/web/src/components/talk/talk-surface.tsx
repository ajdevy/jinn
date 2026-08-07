import { useCallback, useEffect, useMemo, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { closePreview } from "./media-preview-store"
import type { OrbState } from "./orb-motion"
import { readPark, type Point } from "./orb-park"
import { breakpointOf, dockPoint, type SheetRect } from "./situation-choreography"
import { SituationSheet } from "./situation-sheet"
import { TalkOrb } from "./talk-orb"
import { dismissSituation, resolveSituation, useSituation } from "./talk-situation-store"

/**
 * Orb plus sheet, as one surface. It is portalled to `document.body` on purpose:
 * the sheet deactivates `#root` while it is open, and the orb has to stay live
 * and draggable through the whole decision, which it cannot do from inside it.
 */

interface TalkSurfaceProps {
  state?: OrbState
  levelRef?: RefObject<number>
  /** What the operator picked. The situation comes down either way. */
  onAnswer?: (situationId: string, choiceId: string) => void
}

export function TalkSurface({ state = "idle", levelRef, onAnswer }: TalkSurfaceProps) {
  const situation = useSituation()
  const [sheetRect, setSheetRect] = useState<SheetRect | null>(null)

  // Answering resolves rather than dismisses: a decision that was made leaves
  // nothing behind to raise again.
  const answer = useCallback(
    (choiceId: string) => {
      if (situation) onAnswer?.(situation.id, choiceId)
      resolveSituation()
    },
    [situation, onAnswer],
  )

  // A preview belongs to the situation that raised it, so it goes when that does.
  useEffect(() => {
    if (!situation) closePreview()
  }, [situation])

  // The sheet is up but unmeasured for exactly one frame; until then the orb has
  // nowhere to fly to, so it stays parked rather than guessing at a dock point.
  // Memoised because a fresh point every render would restart the flight.
  const dock = useMemo<Point | null>(() => {
    if (!situation || !sheetRect) return null
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    return dockPoint(readPark(), sheetRect, viewport, breakpointOf(viewport))
  }, [situation, sheetRect])

  return createPortal(
    <>
      <SituationSheet
        situation={situation}
        onAnswer={answer}
        onDismiss={dismissSituation}
        onLayout={setSheetRect}
      />
      <TalkOrb state={state} levelRef={levelRef} dock={dock} />
    </>,
    document.body,
  )
}
