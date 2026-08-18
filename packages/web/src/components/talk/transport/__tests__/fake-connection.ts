/**
 * The peer connection, by hand, and control over when it finishes attaching.
 *
 * jsdom implements none of `RTCPeerConnection`, `getUserMedia`, or
 * `AudioContext`, so the real one is never constructed in these tests —
 * `connectRealtime` is injected, which is what that seam is for.
 */
import { vi } from "vitest"
import type { ConnectOptions } from "../webrtc-connection"

export class FakeConnection {
  static opened: FakeConnection[] = []

  readonly sent: Array<Record<string, unknown>> = []
  readonly token: string
  closes = 0
  private readonly onOpen: () => void
  private readonly onFrame: (data: string) => void
  private readonly onClose: ConnectOptions["onClose"]

  constructor(options: Pick<ConnectOptions, "token" | "onOpen" | "onFrame"> & Partial<Pick<ConnectOptions, "onClose">>) {
    this.token = options.token
    this.onOpen = options.onOpen
    this.onFrame = options.onFrame
    this.onClose = options.onClose ?? (() => {})
    FakeConnection.opened.push(this)
  }

  /** Dropped once closed, as the real one is: it sends only while the channel's
   *  `readyState` is open (webrtc-connection.ts). */
  send(event: Record<string, unknown>) {
    if (this.closes > 0) return
    this.sent.push(event)
  }

  close() {
    if (this.closes > 0) return
    this.closes = 1
    this.onClose("expected")
  }

  /** The provider/network dropping an established peer, as distinct from the
   *  operator deliberately ending it. */
  fail() {
    if (this.closes > 0) return
    this.closes = 1
    this.onClose("failed")
  }

  /** The data channel reaching `open`, which is what starts the conversation. */
  openChannel() {
    this.onOpen()
  }

  /** One frame down the channel. A closed peer has no channel left to carry
   *  one, so a delivery after teardown reaches nothing — which is the point of
   *  delivering one. */
  deliver(data: string) {
    if (this.closes > 0) return
    this.onFrame(data)
  }
}

export const connect = vi.fn(async (options: ConnectOptions) => {
  const connection = new FakeConnection(options)
  // Real channels open after the SDP round trip settles, so this one does too.
  queueMicrotask(() => connection.openChannel())
  return connection
})

/**
 * Hold the next connection open mid-attach, and hand back the release.
 *
 * A real attach spans an SDP round trip and a microphone prompt, which is long
 * enough for the operator to close the tab or the orb. The tests that care about
 * that window need to stand inside it.
 */
export function holdNextConnect() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  connect.mockImplementationOnce(async (options: ConnectOptions) => {
    const connection = new FakeConnection(options)
    await held
    queueMicrotask(() => connection.openChannel())
    return connection
  })
  return release
}
