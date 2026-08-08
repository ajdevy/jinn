import { useEffect } from "react"
import { presentSituation } from "./talk-situation-store"
import { TalkSurface } from "./talk-surface"
import { useTalkSession } from "./transport/use-talk-session"

/**
 * The talk surface with a real session behind it.
 *
 * It exists so the transport stays inside the lazily-loaded chunk: the overlay
 * above it is on the app's critical path and must not import the tool registry,
 * and `TalkSurface` below it is driven by hand on the orb bench, where opening
 * a paid session would be exactly the wrong thing for a button to do. This is
 * the one place the two meet.
 */

/** Replaces itself rather than stacking: one voice failure at a time is all
 *  there is to say. */
const FAILURE_ID = "talk-transport-failure"

interface TalkLiveSurfaceProps {
  /** The open session, as the store reports it — the hook below sets it. */
  sessionId?: string | null
}

export function TalkLiveSurface({ sessionId = null }: TalkLiveSurfaceProps) {
  const talk = useTalkSession()
  const { active, error } = talk

  // The sheet is the surface's own text channel, so a refusal is told the same
  // way everything else is. The message is whoever refused's own words: the
  // operator can act on "realtime is not configured" and cannot act on
  // "something went wrong".
  useEffect(() => {
    if (!error) return
    presentSituation({
      id: FAILURE_ID,
      title: active ? "Voice stopped" : "Voice could not start",
      payload: { kind: "prose", text: error },
    })
  }, [active, error])

  return (
    <TalkSurface
      state={talk.state}
      levelRef={talk.levelRef}
      sessionId={sessionId}
      active={active}
      onToggle={talk.toggle}
    />
  )
}
