/**
 * What the session lifecycle acts on, shared by the pieces that act on it.
 *
 * Its own module so opening, closing, and parking can each be a plain function
 * in whichever file it belongs to, rather than a closure over the hook's body —
 * and so none of them has to import the hook back.
 */
import type { RefObject } from "react"
import type { OrbState } from "../orb-motion"
import type { Attachment } from "./attachment"

export interface LiveSession {
  id: string
  /** Null while parked: the connection is dropped so the provider bills nothing. */
  attachment: Attachment | null
  stopHeartbeat: () => void
}

/** Voice cannot open because it has never been set up. Carries what the setup
 *  card needs to offer a provider that would actually work. */
export interface TalkSetupNeeded {
  providers: string[]
}

/** What opening, closing, parking and resuming all need in order to act on the
 *  session. One object, so each of them is a plain function rather than another
 *  closure over the hook's body. */
export interface SessionControls {
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
  setSetup: (setup: TalkSetupNeeded | null) => void
}

/** Whoever refused, in their own words. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
