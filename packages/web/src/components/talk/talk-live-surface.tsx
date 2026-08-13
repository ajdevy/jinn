import { useCallback, useEffect } from "react"
import { VOICE_SETUP_SAVED } from "./renderers/voice-setup"
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
const SETUP_ID = "talk-voice-setup"

interface TalkLiveSurfaceProps {
  /** The open session, as the store reports it — the hook below sets it. */
  sessionId?: string | null
}

export function TalkLiveSurface({ sessionId = null }: TalkLiveSurfaceProps) {
  const talk = useTalkSession()
  const { active, error, setup, toggle } = talk

  // The sheet is the surface's own text channel, so a refusal is told the same
  // way everything else is. The message is whoever refused's own words: the
  // operator can act on "the provider refused a credential" and cannot act on
  // "something went wrong".
  useEffect(() => {
    if (!error) return
    presentSituation({
      id: FAILURE_ID,
      title: active ? "Voice stopped" : "Voice could not start",
      payload: { kind: "prose", text: error },
    })
  }, [active, error])

  // Voice that was never set up is not a failure to report, it is a gap with
  // something to do about it — so it gets a card that does it rather than the
  // sentence the provider factory would have thrown.
  useEffect(() => {
    if (!setup) return
    presentSituation({
      id: SETUP_ID,
      title: "Set up voice",
      hint: "The orb needs a realtime provider before it can open a session.",
      payload: { kind: "voice-setup", providers: setup.providers },
    })
  }, [setup])

  // Saving answered the card, so the press that raised it can now be honoured.
  const onAnswer = useCallback(
    (situationId: string, choiceId: string) => {
      if (situationId === SETUP_ID && choiceId === VOICE_SETUP_SAVED) toggle()
    },
    [toggle],
  )

  return (
    <TalkSurface
      state={talk.state}
      levelRef={talk.levelRef}
      sessionId={sessionId}
      active={active}
      onToggle={toggle}
      onAnswer={onAnswer}
    />
  )
}
