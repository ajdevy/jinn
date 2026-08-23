/**
 * The provider connection and the driver that speaks over it.
 *
 * They belong in one module because they are brought up together and dropped
 * together: a driver outliving its channel would go on pushing page context at a
 * connection that is not there, and a channel outliving its driver would be
 * answered by nobody. `use-talk-session.ts` is left with the session lifecycle.
 */
import { useCallback, type RefObject } from "react"
import type { OrbEnergy, OrbState } from "../orb-motion"
import { createTalkDriver, type TalkDriver } from "./session-driver"
import type { ConnectRealtime, TalkConnection } from "./webrtc-connection"
import type { TalkControlManifest } from "./control-manifest"
import { postTalkInterruption, type TalkVadType } from "./session-client"

export interface Attachment {
  connection: TalkConnection
  driver: TalkDriver
}

export interface TalkCredentialIdentity {
  browserInstanceId: string
  credentialGeneration: number
  topicMemory?: string
  vadType?: TalkVadType
}

/** Drop both halves. Called wherever the connection goes: close, park, page
 *  unload, and the paths where an attach finished behind a teardown. */
export function detach(attachment: Attachment): void {
  attachment.driver.stop()
  attachment.connection.close()
}

function reportConnectionClose(
  reason: "expected" | "failed",
  setState: (state: OrbState) => void,
  setError: (message: string | null) => void,
): void {
  if (reason === "failed") {
    setError("The realtime connection was interrupted.")
    setState("error")
  } else setState("idle")
}

function reportDriverState(
  state: OrbState,
  setState: (state: OrbState) => void,
  setError: (message: string | null) => void,
): void {
  if (state !== "error") setError(null)
  setState(state)
}

/**
 * Bring up the provider connection for an already-open talk session.
 *
 * The driver is built before the connection so that a data channel which opens
 * before `connect` resolves still gets its `session.update` — once, and never
 * before there is something to send it on.
 */
export function useAttach(
  connect: ConnectRealtime,
  energy: RefObject<OrbEnergy>,
  setState: (state: OrbState) => void,
  setError: (message: string | null) => void,
) {
  return useCallback(
    async (id: string, token: string, brief: string, manifest: TalkControlManifest, identity: TalkCredentialIdentity): Promise<Attachment> => {
      let connection: TalkConnection | null = null
      let channelOpen = false
      let started = false
      const start = () => {
        if (started || !channelOpen || !connection) return
        started = true
        driver.start()
      }
      const driver = createTalkDriver({
        sessionId: id,
        browserInstanceId: identity.browserInstanceId,
        credentialGeneration: identity.credentialGeneration,
        brief,
        topicMemory: identity.topicMemory,
        manifest,
        vadType: identity.vadType ?? "semantic_vad",
        onInterruption: (event) => { void postTalkInterruption(id, event).catch(() => {}) },
        send: (event) => connection?.send(event),
        onState: (state) => reportDriverState(state, setState, setError),
        onError: setError,
      })

      connection = await connect({
        token,
        energy,
        onOpen: () => {
          channelOpen = true
          start()
        },
        onFrame: driver.receive,
        onClose: (reason) => {
          driver.stop()
          reportConnectionClose(reason, setState, setError)
        },
      })
      start()
      return { connection, driver }
    },
    [connect, energy, setState, setError],
  )
}
