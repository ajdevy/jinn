/**
 * The peer connection to the realtime provider: microphone up, voice down, and
 * an `oai-events` data channel for everything that is not audio.
 *
 * The gateway never sees a byte of this. It minted the credential and priced
 * the turn; the media is between the browser and the provider, which is the
 * whole point of the runtime (docs/talk-session-runtime.md).
 *
 * `connectRealtime` is injected into the hook rather than imported by it, so
 * the lifecycle can be driven by a fake in a test — jsdom implements none of
 * `RTCPeerConnection`, `getUserMedia`, or `AudioContext`.
 */
import type { OrbEnergy } from "../orb-motion"

/**
 * OpenAI's SDP exchange, confirmed against the Realtime WebRTC guide on
 * 2026-08-08 (developers.openai.com/api/docs/guides/realtime-webrtc). No model
 * query parameter: the session — model, voice, and tool scope — is bound to the
 * ephemeral credential when the gateway mints it, and a browser that could name
 * its own model could name a dearer one.
 */
const SDP_URL = "https://api.openai.com/v1/realtime/calls"

/** The channel name the provider expects. Anything else is never opened. */
const EVENT_CHANNEL = "oai-events"

export interface TalkConnection {
  /** Send one client event over the data channel. */
  send: (event: Record<string, unknown>) => void
  /** Drop the provider connection and cool the microphone. */
  close: () => void
}

export interface ConnectOptions {
  /** The ephemeral credential from `POST /api/talk/sessions`. */
  token: string
  /** Written each frame with the 0..1 loudness of each side, for the orb's
   *  lobes. Mutated in place: at 60fps for two streams, a fresh object per
   *  frame is garbage the whole call long. */
  energy: { current: OrbEnergy }
  onOpen: () => void
  onFrame: (data: string) => void
  onClose: (reason: "expected" | "failed") => void
}

export type ConnectRealtime = (options: ConnectOptions) => Promise<TalkConnection>

/**
 * Drive one channel of `energy` from one stream, so the orb answers audio rather
 * than a timer. Returns its own teardown.
 *
 * Both sides are metered by the same code and differ only in which channel they
 * write: the microphone feeds `input`, the assistant's track feeds `output`.
 * They overlap during a barge-in, which is exactly why they are two channels.
 *
 * The analyser is never connected to the context destination. Routing the
 * microphone to the speakers would echo the operator back at themselves.
 */
function meterStream(
  stream: MediaStream,
  energy: { current: OrbEnergy },
  channel: keyof OrbEnergy,
): () => void {
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Uint8Array(analyser.frequencyBinCount)
  let frame = 0

  const read = () => {
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) {
      const centred = (sample - 128) / 128
      sum += centred * centred
    }
    // RMS is a quiet number for speech; the orb reads 0..1, so it is scaled and
    // clamped rather than left to sit near zero for a normal speaking voice.
    energy.current[channel] = Math.min(1, Math.sqrt(sum / samples.length) * 4)
    frame = requestAnimationFrame(read)
  }
  frame = requestAnimationFrame(read)

  return () => {
    cancelAnimationFrame(frame)
    energy.current[channel] = 0
    void context.close().catch(() => {})
  }
}

/** A browser that refuses an AudioContext still gets its call. The orb loses its
 *  pulse, which is not a reason to fail a voice session. */
function meter(stream: MediaStream, energy: { current: OrbEnergy }, channel: keyof OrbEnergy): () => void {
  try {
    return meterStream(stream, energy, channel)
  } catch {
    return () => {}
  }
}

/** Play the assistant's voice. Detached from the DOM: it carries no controls
 *  and nothing on the page should be able to lay it out. */
function remoteAudio(): HTMLAudioElement {
  const audio = document.createElement("audio")
  audio.autoplay = true
  return audio
}

async function exchangeSdp(offer: string, token: string): Promise<string> {
  const response = await fetch(SDP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
    body: offer,
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`The realtime provider refused the connection (${response.status}): ${body.slice(0, 200)}`)
  }
  return body
}

/** Everything the peer does on its own: play the assistant, meter it for the
 *  orb, and report a connection the provider dropped as a closed one. */
function wirePeer(
  peer: RTCPeerConnection,
  options: ConnectOptions,
  audio: HTMLAudioElement,
  close: (reason: "expected" | "failed") => void,
): { stop: () => void } {
  let stopMeter: (() => void) | null = null
  peer.ontrack = (event) => {
    const stream = event.streams[0]
    if (!stream) return
    audio.srcObject = stream
    void audio.play().catch(() => {})
    stopMeter?.()
    stopMeter = meter(stream, options.energy, "output")
  }
  // A connection the provider dropped is a closed session, not a live one the
  // orb keeps animating.
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") close("failed")
  }
  return { stop: () => stopMeter?.() }
}

export const connectRealtime: ConnectRealtime = async (options) => {
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
  const peer = new RTCPeerConnection()
  const audio = remoteAudio()
  let closed = false
  // The microphone is metered from the moment it is granted, so the orb can
  // ride the operator's own voice — the remote track only ever answered the
  // assistant.
  const stopInputMeter = meter(microphone, options.energy, "input")

  const close = (reason: "expected" | "failed") => {
    if (closed) return
    closed = true
    stopInputMeter()
    outputMeter.stop()
    for (const track of microphone.getTracks()) track.stop()
    audio.srcObject = null
    peer.close()
    options.onClose(reason)
  }
  const outputMeter = wirePeer(peer, options, audio, close)

  try {
    for (const track of microphone.getTracks()) peer.addTrack(track, microphone)
    const channel = peer.createDataChannel(EVENT_CHANNEL)
    channel.onopen = () => options.onOpen()
    channel.onmessage = (event: MessageEvent) => options.onFrame(String(event.data))

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const answer = await exchangeSdp(offer.sdp ?? "", options.token)
    await peer.setRemoteDescription({ type: "answer", sdp: answer })

    return {
      send: (event) => {
        if (channel.readyState !== "open") throw new Error("The realtime data channel is not open.")
        channel.send(JSON.stringify(event))
      },
      close: () => close("expected"),
    }
  } catch (error) {
    // Nothing half-open survives a failed connect: the microphone goes cold and
    // the peer goes away before the failure is reported.
    close("expected")
    throw error
  }
}
