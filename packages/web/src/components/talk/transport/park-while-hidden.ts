/**
 * A hidden tab keeps its session and its history but drops the connection, so a
 * tab switch costs nothing and coming back is not a fresh conversation. The
 * heartbeat carries on through it: the reaper does not read state, and a parked
 * session it collects is one the operator cannot come back to.
 */
import { useEffect } from "react"
import { rememberResumableTalkSession } from "../talk-session-store"
import { detach } from "./attachment"
import { parkTalkSession } from "./session-client"
import { reason, type LiveSession, type SessionControls } from "./session-controls"

export function useParkWhileHidden(controls: SessionControls): void {
  useEffect(() => {
    const park = (live: LiveSession) => {
      if (!live.attachment) return
      detach(live.attachment)
      live.attachment = null
      live.parkedAtGateway = false
      rememberResumableTalkSession(live.id)
      controls.setActive(false)
      controls.setParked(true)
      controls.setState("idle")
      void parkTalkSession(live.id)
        .then(() => { live.parkedAtGateway = true })
        .catch((failure) => controls.setError(reason(failure)))
    }

    const onVisibility = () => {
      const live = controls.liveRef.current
      if (!live) return
      if (document.hidden) park(live)
      // Becoming visible is observational only. A fresh operator gesture is
      // required before a credential, microphone, or provider connection returns.
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [controls])
}
