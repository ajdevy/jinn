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
import { detach, useAttach } from "./attachment"
import { fetchTalkCapability } from "@/lib/talk-capability"
import { useParkWhileHidden } from "./park-while-hidden"
import {
  VoiceUnconfiguredError,
  closeTalkSession,
  openTalkSession,
  startTalkHeartbeat,
} from "./session-client"
import { reason, type LiveSession, type SessionControls, type TalkSetupNeeded } from "./session-controls"
import { connectRealtime, type ConnectRealtime } from "./webrtc-connection"

export type { TalkSetupNeeded }

export interface TalkSessionHandle {
  /** Whether a session is open, which is what the orb's control reflects. */
  active: boolean
  state: OrbState
  levelRef: RefObject<number>
  /** The last failure, in the words of whoever refused. Null once it is past. */
  error: string | null
  /** Set instead of `error` when the only thing wrong is that voice was never
   *  configured — a gap with something to do about it, not a message. */
  setup: TalkSetupNeeded | null
  toggle: () => void
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
 *
 * It starts by asking whether voice is set up at all, because the alternative is
 * charging the operator for the answer. The gateway can still refuse the mint
 * for the same reason — the config can change between the two calls — and that
 * refusal is routed to the same place rather than shown as a message.
 */
async function openSession(controls: SessionControls): Promise<void> {
  if (controls.liveRef.current || controls.openingRef.current) return
  controls.openingRef.current = true
  controls.setError(null)
  controls.setSetup(null)
  controls.setState("thinking")

  const generation = controls.generationRef.current
  let opened: string | null = null
  let providers: string[] = []
  try {
    const capability = await fetchTalkCapability()
    providers = capability.providers
    if (!capability.configured) {
      controls.setSetup({ providers })
      controls.setState("idle")
      return
    }
    const session = await openTalkSession()
    opened = session.id
    setTalkSessionId(opened)
    const attachment = await controls.attach(opened, session.token, session.brief, session.manifest)
    if (generation !== controls.generationRef.current) {
      detach(attachment)
      setTalkSessionId(null)
      void closeTalkSession(opened).catch(() => {})
      return
    }
    controls.liveRef.current = {
      id: opened,
      attachment,
      brief: session.brief,
      manifest: session.manifest,
      stopHeartbeat: startTalkHeartbeat(opened),
    }
    controls.setActive(true)
    controls.setState("listening")
  } catch (failure) {
    if (failure instanceof VoiceUnconfiguredError) controls.setSetup({ providers })
    else controls.setError(reason(failure))
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
  const [setup, setSetup] = useState<TalkSetupNeeded | null>(null)
  const levelRef = useRef(0)
  const liveRef = useRef<LiveSession | null>(null)
  const openingRef = useRef(false)
  const generationRef = useRef(0)
  const attach = useAttach(connect, levelRef, setState, setError)
  const forget = useForget(liveRef, generationRef, setActive, setState)

  const controls = useMemo<SessionControls>(
    () => ({ liveRef, openingRef, generationRef, attach, forget, setActive, setState, setError, setSetup }),
    [attach, forget],
  )

  const toggle = useCallback(() => {
    if (liveRef.current) void closeSession(controls)
    else void openSession(controls)
  }, [controls])

  useParkWhileHidden(controls)
  useCloseOnLeaving(liveRef, generationRef, forget)

  return { active, state, levelRef, error, setup, toggle }
}
