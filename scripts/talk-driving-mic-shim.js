/**
 * Browser init script for the disposable Talk driving journey.
 *
 * It replaces microphone capture with a silent MediaStream destination that a
 * WAV can be played into, and observes only compact Realtime data-channel
 * frames. Load it before the first localhost navigation with agent-browser's
 * --init-script option.
 */
;(() => {
  const MAX_FRAMES = 200
  const incoming = []
  const outgoing = []
  const spoken = []
  const observedChannels = new WeakSet()
  let channelState = "pending"
  let context = null
  let microphone = null
  let silenceCarrier = null

  function push(list, value) {
    list.push(value)
    if (list.length > MAX_FRAMES) list.splice(0, list.length - MAX_FRAMES)
  }

  function text(value) {
    return typeof value === "string" ? value.slice(0, 2_000) : undefined
  }

  function summarize(raw) {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return { at: new Date().toISOString(), type: "non-json" } }
    const item = frame?.item && typeof frame.item === "object" ? frame.item : {}
    return {
      at: new Date().toISOString(),
      type: text(frame?.type) ?? "unknown",
      eventId: text(frame?.event_id),
      callId: text(frame?.call_id ?? item.call_id),
      itemId: text(frame?.item_id ?? item.id),
      name: text(frame?.name ?? item.name),
      transcript: text(frame?.transcript ?? frame?.delta),
      arguments: text(frame?.arguments ?? item.arguments),
      output: text(item.output),
      status: text(frame?.response?.status ?? frame?.status),
      error: text(frame?.error?.message ?? frame?.message),
    }
  }

  function audio() {
    if (context && microphone) return { context, microphone }
    const Audio = window.AudioContext ?? window.webkitAudioContext
    if (!Audio) throw new Error("The Talk driving microphone shim needs AudioContext")
    context = new Audio({ sampleRate: 24_000 })
    microphone = context.createMediaStreamDestination()
    const silence = context.createGain()
    // Keep this just above digital zero so WebRTC cannot suppress the carrier
    // as discontinuous transmission, while remaining inaudible and below VAD.
    silence.gain.value = 0.0003
    silence.connect(microphone)
    silenceCarrier = context.createOscillator()
    silenceCarrier.connect(silence)
    silenceCarrier.start()
    return { context, microphone }
  }

  const mediaDevices = navigator.mediaDevices ?? {}
  const nativeGetUserMedia = typeof mediaDevices.getUserMedia === "function"
    ? mediaDevices.getUserMedia.bind(mediaDevices)
    : null
  mediaDevices.getUserMedia = async (constraints) => {
    if (constraints?.audio) return audio().microphone.stream
    if (nativeGetUserMedia) return nativeGetUserMedia(constraints)
    throw new Error("No native media device is available for these constraints")
  }
  if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices })

  function observe(channel) {
    if (!channel || observedChannels.has(channel)) return channel
    observedChannels.add(channel)
    channelState = channel.readyState
    channel.addEventListener("open", () => { channelState = "open" })
    channel.addEventListener("closing", () => { channelState = "closing" })
    channel.addEventListener("close", () => { channelState = "closed" })
    channel.addEventListener("message", (event) => push(incoming, summarize(event.data)))
    const nativeSend = channel.send.bind(channel)
    channel.send = (raw) => {
      push(outgoing, summarize(raw))
      return nativeSend(raw)
    }
    return channel
  }

  const nativeCreateDataChannel = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    return observe(nativeCreateDataChannel.apply(this, args))
  }

  window.__talkDriving = {
    version: 1,
    async speakWav(encoded) {
      const runtime = audio()
      await runtime.context.resume()
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
      const decoded = await runtime.context.decodeAudioData(bytes.buffer.slice(0))
      const source = runtime.context.createBufferSource()
      source.buffer = decoded
      source.connect(runtime.microphone)
      const silence = runtime.context.createBufferSource()
      silence.buffer = runtime.context.createBuffer(1, Math.ceil(runtime.context.sampleRate * 1.25), runtime.context.sampleRate)
      silence.connect(runtime.microphone)
      const entry = { startedAt: new Date().toISOString(), duration: decoded.duration }
      push(spoken, entry)
      await new Promise((resolve) => {
        // Keep sending real zero-valued audio after the WAV. A destination with
        // no connected source may stop producing frames, which leaves provider
        // VAD in speech_started forever instead of proving the turn boundary.
        source.onended = () => {
          silence.onended = resolve
          silence.start()
        }
        source.start()
      })
      return entry
    },
    probe() {
      return {
        version: 1,
        channelState,
        incoming: incoming.map((frame) => ({ ...frame })),
        outgoing: outgoing.map((frame) => ({ ...frame })),
        spoken: spoken.map((entry) => ({ ...entry })),
      }
    },
    clear() {
      incoming.splice(0)
      outgoing.splice(0)
      spoken.splice(0)
    },
  }
})()
