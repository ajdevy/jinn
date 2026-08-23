import { useCallback } from "react"
import { TalkSurface } from "./talk-surface"
import { talkNavigator } from "./tools/router-handle"
import { useTalkProactiveCues } from "./transport/proactive-cues"
import { useTalkSession } from "./transport/use-talk-session"
import type { OrbVariant } from "./orb-motion"

interface TalkLiveSurfaceProps {
  /** The open session, as the store reports it — the hook below sets it. */
  sessionId?: string | null
  variant?: OrbVariant
}

/**
 * Aurora with its live transport. Talk has no parallel card or transcript:
 * setup and transport failures are the orb's error motion, and setup hands the
 * operator to the existing Settings route on the next explicit press.
 */
export function TalkLiveSurface({ sessionId = null, variant = "mist" }: TalkLiveSurfaceProps) {
  const talk = useTalkSession()
  const needsSetup = talk.setup !== null
  const state = talk.error || needsSetup ? "error" : talk.state
  const label = needsSetup ? "Open voice settings" : talk.error ? "Retry voice session" : undefined
  useTalkProactiveCues(sessionId, talk.active, talk.cue)

  const onToggle = useCallback(() => {
    if (needsSetup) {
      void talkNavigator()?.("/settings")
      return
    }
    talk.toggle()
  }, [needsSetup, talk])

  return (
    <TalkSurface
      state={state}
      variant={variant}
      energyRef={talk.energyRef}
      sessionId={sessionId}
      active={talk.active}
      label={label}
      onToggle={onToggle}
    />
  )
}
