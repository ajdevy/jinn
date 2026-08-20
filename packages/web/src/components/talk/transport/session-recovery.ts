import { useEffect } from "react"
import { browserInstanceId } from "../context/browser-instance"
import {
  clearResumableTalkSession,
  readResumableTalkSession,
  rememberResumableTalkSession,
  setTalkSessionId,
} from "../talk-session-store"
import { detach } from "./attachment"
import {
  TalkSessionMissingError,
  closeTalkSession,
  getTalkSession,
  parkTalkSession,
  resumeTalkSession,
  startTalkHeartbeat,
  type ResumableTalkSession,
} from "./session-client"
import { reason, type LiveSession, type SessionControls } from "./session-controls"

function heldSession(status: ResumableTalkSession): LiveSession {
  return {
    id: status.id,
    attachment: null,
    brief: status.brief,
    topicMemory: status.topicMemory,
    manifest: status.manifest,
    browserInstanceId: status.browserInstanceId,
    parkedAtGateway: status.state === "parked",
    stopHeartbeat: () => {},
  }
}

async function resolveCandidate(controls: SessionControls): Promise<LiveSession | null> {
  const existing = controls.liveRef.current
  if (existing) return existing
  const id = readResumableTalkSession()
  if (!id) return null
  const status = await getTalkSession(id)
  if (status.browserInstanceId !== browserInstanceId()) {
    clearResumableTalkSession(id)
    return null
  }
  const live = heldSession(status)
  controls.liveRef.current = live
  setTalkSessionId(live.id)
  controls.setActive(false)
  controls.setParked(true)
  return live
}

async function attachCandidate(controls: SessionControls, live: LiveSession, generation: number): Promise<void> {
  // Settle a pagehide request that may still be in flight before asking the
  // gateway to rotate the credential. Already-parked candidates skip the write.
  if (!live.parkedAtGateway) await parkTalkSession(live.id)
  live.parkedAtGateway = true
  const resumed = await resumeTalkSession(live.id)
  const attachment = await controls.attach(live.id, resumed.token, live.brief, live.manifest, {
    browserInstanceId: live.browserInstanceId,
    credentialGeneration: resumed.credentialGeneration,
    topicMemory: live.topicMemory,
    vadType: resumed.vadType ?? "semantic_vad",
  })
  if (generation !== controls.generationRef.current) {
    detach(attachment)
    void parkTalkSession(live.id).catch(() => {})
    return
  }
  live.stopHeartbeat()
  live.stopHeartbeat = startTalkHeartbeat(live.id)
  live.attachment = attachment
  live.parkedAtGateway = false
  rememberResumableTalkSession(live.id)
  setTalkSessionId(live.id)
  controls.setActive(true)
  controls.setParked(false)
  controls.setState("listening")
}

export async function resumeHeldSession(
  controls: SessionControls,
  openNew: () => Promise<void>,
): Promise<void> {
  if (controls.openingRef.current) return
  controls.openingRef.current = true
  controls.setError(null)
  controls.setSetup(null)
  controls.setState("thinking")
  const generation = controls.generationRef.current
  let missing = false
  try {
    const live = await resolveCandidate(controls)
    if (!live) missing = true
    else await attachCandidate(controls, live, generation)
  } catch (failure) {
    if (failure instanceof TalkSessionMissingError) {
      const live = controls.liveRef.current
      if (live) controls.forget(live)
      const id = readResumableTalkSession()
      if (id) clearResumableTalkSession(id)
      missing = true
    } else {
      controls.setError(reason(failure))
      controls.setState("idle")
      controls.setActive(false)
      controls.setParked(true)
    }
  } finally {
    controls.openingRef.current = false
  }
  if (missing) await openNew()
}

export async function startOverTalkRuntime(
  controls: SessionControls,
  openNew: () => Promise<void>,
): Promise<void> {
  if (controls.openingRef.current) return
  controls.openingRef.current = true
  const live = controls.liveRef.current
  const id = live?.id ?? readResumableTalkSession()
  if (live) controls.forget(live)
  else controls.generationRef.current += 1
  if (id) clearResumableTalkSession(id)
  try {
    if (id) await closeTalkSession(id)
  } catch (failure) {
    if (!(failure instanceof TalkSessionMissingError)) {
      controls.setError(reason(failure))
      controls.openingRef.current = false
      return
    }
  }
  controls.openingRef.current = false
  await openNew()
}

/** Read-only cold discovery: no capability probe, credential, or microphone. */
export function useDiscoverResumable(controls: SessionControls): void {
  useEffect(() => {
    const id = readResumableTalkSession()
    if (!id) return
    const generation = controls.generationRef.current
    let cancelled = false
    void getTalkSession(id)
      .then((status) => {
        if (cancelled || generation !== controls.generationRef.current || controls.liveRef.current) return
        if (status.browserInstanceId !== browserInstanceId()) {
          clearResumableTalkSession(id)
          return
        }
        controls.liveRef.current = heldSession(status)
        setTalkSessionId(id)
        controls.setParked(true)
      })
      .catch((failure) => {
        if (!cancelled && failure instanceof TalkSessionMissingError) clearResumableTalkSession(id)
      })
    return () => { cancelled = true }
  }, [controls])
}
