/**
 * The provider connection and the driver that speaks over it.
 *
 * They belong in one module because they are brought up together and dropped
 * together: a driver outliving its channel would go on pushing page context at a
 * connection that is not there, and a channel outliving its driver would be
 * answered by nobody. `use-talk-session.ts` is left with the session lifecycle.
 */
import { useCallback, type RefObject } from "react"
import type { OrbState } from "../orb-motion"
import { createTalkDriver, type TalkDriver } from "./session-driver"
import type { ConnectRealtime, TalkConnection } from "./webrtc-connection"

export interface Attachment {
  connection: TalkConnection
  driver: TalkDriver
}

/** Drop both halves. Called wherever the connection goes: close, park, page
 *  unload, and the paths where an attach finished behind a teardown. */
export function detach(attachment: Attachment): void {
  attachment.driver.stop()
  attachment.connection.close()
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
  level: RefObject<number>,
  setState: (state: OrbState) => void,
  setError: (message: string) => void,
) {
  return useCallback(
    async (id: string, token: string): Promise<Attachment> => {
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
        send: (event) => connection?.send(event),
        onState: setState,
        onError: setError,
      })

      connection = await connect({
        token,
        level,
        onOpen: () => {
          channelOpen = true
          start()
        },
        onFrame: driver.receive,
        onClose: () => setState("idle"),
      })
      start()
      return { connection, driver }
    },
    [connect, level, setState, setError],
  )
}
