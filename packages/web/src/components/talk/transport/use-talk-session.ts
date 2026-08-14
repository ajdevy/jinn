/**
 * The talk session's lifecycle, as React sees it.
 *
 * Nothing here runs on mount. Opening a session mints a paid provider
 * credential and asks for the microphone, so it happens on the operator's
 * gesture and on nothing else — not a mount, not a route change, not a retry.
 *
 * The session itself lives in a ref rather than in state: it is an open
 * connection with a heartbeat behind it, and re-rendering must not be able to
 * open a second one. What renders is only what the orb shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { OrbState } from "../orb-motion"
import { setTalkSessionId } from "../talk-session-store"
import { detach, useAttach, type Attachment } from "./attachment"
import {
  closeTalkSession,
  openTalkSession,
  parkTalkSession,
  resumeTalkSession,
  startTalkHeartbeat,
} from "./session-client"
import { connectRealtime, type ConnectRealtime } from "./webrtc-connection"

interface LiveSession {
  id: string
  /** Null while parked: the connection is dropped so the provider bills nothing. */
  attachment: Attachment | null
  stopHeartbeat: () => void
}

/** What opening, closing, parking and resuming all need in order to act on the
 *  session. One object, so each of them is a plain function rather than another
 *  closure over the hook's body. */
interface SessionControls {
  liveRef: RefObject<LiveSession | null>
  /** True between the open request and its answer, so a second press cannot
   *  mint a second credential. */
  openingRef: RefObject<boolean>
  /** Bumped by every teardown. A connection that finished opening across a bump
   *  belongs to a session nobody is waiting for, and hands itself back rather
   *  than turning the microphone on behind a closed session. */
  generationRef: RefObject<number>
  attach: (id: string, token: string) => Promise<Attachment>
  forget: (live: LiveSession) => void
  setActive: (active: boolean) => void
  setState: (state: OrbState) => void
  setError: (message: string | null) => void
}

export interface TalkSessionHandle {
  /** Whether a session is open, which is what the orb's control reflects. */
  active: boolean
  state: OrbState
  levelRef: RefObject<number>
  /** The last failure, in the words of whoever refused. Null once it is past. */
  error: string | null
  toggle: () => void
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Tear the session down locally, whatever the gateway makes of the DELETE. */
function useForget(
  liveRef: RefObject<LiveSession | null>,
  generationRef: RefObject<number>,
  setActive: (active: boolean) => void,
  setState: (state: OrbState) => void,
) {
  return useCallback(
    (live: LiveSession) => {
      generationRef.current += 1
      live.stopHeartbeat()
      if (live.attachment) detach(live.attachment)
      liveRef.current = null
      setTalkSessionId(null)
      setActive(false)
      setState("idle")
    },
    [liveRef, generationRef, setActive, setState],
  )
}

/**
 * Open a session, then connect to the provider with the credential it minted.
 *
 * The two halves fail differently and both have to leave nothing behind: a
 * refused open never names a session, and a session that opened but never
 * connected is closed here rather than left for the reaper ninety seconds later.
 * A page that left while this was in flight is the same case — the session is
 * named by then, so it is closed on the way out rather than never mentioned.
 */
async function openSession(controls: SessionControls): Promise<void> {
  if (controls.liveRef.current || controls.openingRef.current) return
  controls.openingRef.current = true
  controls.setError(null)
  controls.setState("thinking")

  const generation = controls.generationRef.current
  let opened: string | null = null
  try {
    const session = await openTalkSession()
    opened = session.id
    setTalkSessionId(opened)
    const attachment = await controls.attach(opened, session.token)
    if (generation !== controls.generationRef.current) {
      detach(attachment)
      setTalkSessionId(null)
      void closeTalkSession(opened).catch(() => {})
      return
    }
    controls.liveRef.current = { id: opened, attachment, stopHeartbeat: startTalkHeartbeat(opened) }
    controls.setActive(true)
    controls.setState("listening")
  } catch (failure) {
    controls.setError(reason(failure))
    controls.setState("idle")
    controls.setActive(false)
    if (opened) void closeTalkSession(opened).catch(() => {})
    setTalkSessionId(null)
  } finally {
    controls.openingRef.current = false
  }
}

async function closeSession(controls: SessionControls): Promise<void> {
  const live = controls.liveRef.current
  if (!live) return
  controls.forget(live)
  try {
    await closeTalkSession(live.id)
  } catch (failure) {
    controls.setError(reason(failure))
  }
}

/**
 * A hidden tab keeps its session and its history but drops the connection, so a
 * tab switch costs nothing and coming back is not a fresh conversation. The
 * heartbeat carries on through it: the reaper does not read state, and a parked
 * session it collects is one the operator cannot come back to.
 */
function useParkWhileHidden(controls: SessionControls): void {
  useEffect(() => {
    const park = (live: LiveSession) => {
      if (!live.attachment) return
      detach(live.attachment)
      live.attachment = null
      controls.setState("idle")
      void parkTalkSession(live.id).catch((failure) => controls.setError(reason(failure)))
    }

    const resume = (live: LiveSession) => {
      if (live.attachment) return
      const generation = controls.generationRef.current
      void resumeTalkSession(live.id)
        .then(async (resumed) => {
          const attachment = await controls.attach(live.id, resumed.token)
          if (generation !== controls.generationRef.current) {
            // Closed while this was connecting. The microphone does not come
            // back on for a session that has already been deleted.
            detach(attachment)
            return
          }
          live.attachment = attachment
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

/**
 * A closing tab stops heartbeating and would be reaped, but ninety seconds of a
 * paid credential outliving its page is ninety seconds too many. Unmounting the
 * surface is the same thing by a different route.
 */
function useCloseOnLeaving(
  liveRef: RefObject<LiveSession | null>,
  generationRef: RefObject<number>,
  forget: (live: LiveSession) => void,
): void {
  useEffect(() => {
    const onLeaving = () => {
      // Bumped even with nothing live: an open still in flight has a session
      // named on the gateway, and `openSession` closes it once it sees this.
      generationRef.current += 1
      const live = liveRef.current
      if (!live) return
      forget(live)
      void closeTalkSession(live.id).catch(() => {})
    }
    window.addEventListener("pagehide", onLeaving)
    window.addEventListener("beforeunload", onLeaving)
    return () => {
      window.removeEventListener("pagehide", onLeaving)
      window.removeEventListener("beforeunload", onLeaving)
      // Unmounting the surface is a page leaving by a shorter route. Safe as a
      // teardown because every dependency is stable for the hook's lifetime,
      // so this effect runs once and its cleanup is the unmount.
      onLeaving()
    }
  }, [liveRef, generationRef, forget])
}

export function useTalkSession(connect: ConnectRealtime = connectRealtime): TalkSessionHandle {
  const [active, setActive] = useState(false)
  const [state, setState] = useState<OrbState>("idle")
  const [error, setError] = useState<string | null>(null)
  const levelRef = useRef(0)
  const liveRef = useRef<LiveSession | null>(null)
  const openingRef = useRef(false)
  const generationRef = useRef(0)
  const attach = useAttach(connect, levelRef, setState, setError)
  const forget = useForget(liveRef, generationRef, setActive, setState)

  const controls = useMemo<SessionControls>(
    () => ({ liveRef, openingRef, generationRef, attach, forget, setActive, setState, setError }),
    [attach, forget],
  )

  const toggle = useCallback(() => {
    if (liveRef.current) void closeSession(controls)
    else void openSession(controls)
  }, [controls])

  useParkWhileHidden(controls)
  useCloseOnLeaving(liveRef, generationRef, forget)

  return { active, state, levelRef, error, toggle }
}
