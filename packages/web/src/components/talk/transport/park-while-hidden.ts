/**
 * A hidden tab keeps its session and its history but drops the connection, so a
 * tab switch costs nothing and coming back is not a fresh conversation. The
 * heartbeat carries on through it: the reaper does not read state, and a parked
 * session it collects is one the operator cannot come back to.
 */
import { useEffect } from "react"
import { parkTalkSession, resumeTalkSession } from "./session-client"
import { reason, type LiveSession, type SessionControls } from "./session-controls"

export function useParkWhileHidden(controls: SessionControls): void {
  useEffect(() => {
    const park = (live: LiveSession) => {
      if (!live.connection) return
      live.connection.close()
      live.connection = null
      controls.setState("idle")
      void parkTalkSession(live.id).catch((failure) => controls.setError(reason(failure)))
    }

    const resume = (live: LiveSession) => {
      if (live.connection) return
      const generation = controls.generationRef.current
      void resumeTalkSession(live.id)
        .then(async (resumed) => {
          const connection = await controls.attach(live.id, resumed.token)
          if (generation !== controls.generationRef.current) {
            // Closed while this was connecting. The microphone does not come
            // back on for a session that has already been deleted.
            connection.close()
            return
          }
          live.connection = connection
          controls.setState("listening")
        })
        .catch((failure) => {
          // The session is gone — reaped, or closed under us. Say so and stand
          // down rather than animating an orb attached to nothing.
          controls.setError(reason(failure))
          controls.forget(live)
        })
    }

    const onVisibility = () => {
      const live = controls.liveRef.current
      if (!live) return
      if (document.hidden) park(live)
      else resume(live)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [controls])
}
