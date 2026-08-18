import type { RealtimeFrame } from "./realtime-events"

/** A deliberately conservative ceiling: recovery also requires an explicitly
 * empty transcript, so duration is a correlation guard rather than a guess at
 * what the operator meant. */
const FALSE_START_MAX_MS = 800

export interface InterruptionTelemetry {
  kind: "speech_interruption"
  vadType: "server_vad" | "semantic_vad"
  cancelledBy: "provider"
  recovered: boolean
  speechMs: number | null
}

export function sendFalseStartContinuation(send: (event: Record<string, unknown>) => void): void {
  send({
    type: "response.create",
    response: {
      instructions: "The operator's last sound was incidental. Continue from the last spoken boundary. Do not repeat a complete sentence; restart only a cut-off sentence.",
    },
  })
}

interface Candidate {
  responseId: string
  userItemId: string
  startMs: number | null
  endMs: number | null
  vadCancelled: boolean
  completedBeforeSpeech: boolean
  outputCleared: boolean
  transcriptEmpty: boolean
}

export type InterruptedTranscriptDecision = "continue" | "respond" | "pending"

/** Correlates the provider events that prove a cancelled WebRTC response has a
 * safe continuation boundary. Missing or mismatched evidence always fails
 * closed; no transcript or audio content is retained or reported. */
export class FalseStartRecovery {
  private candidate: Candidate | null = null
  private readonly closedResponses = new Set<string>()
  private disabled = false

  constructor(
    private readonly vadType: InterruptionTelemetry["vadType"],
    private readonly report: (event: InterruptionTelemetry) => void,
  ) {}

  begin(
    frame: Extract<RealtimeFrame, { type: "speech_started" }>,
    responseId: string | null,
    completedBeforeSpeech = false,
    allowed = true,
  ): boolean {
    const itemId = frame.itemId
    if (!itemId || !this.canBegin(responseId, allowed)) return false
    if (this.candidate?.responseId === responseId && this.candidate.userItemId === itemId) return true
    this.forbid()
    if (this.closedResponses.has(responseId)) return false
    this.candidate = {
      responseId,
      userItemId: itemId,
      startMs: frame.audioStartMs ?? null,
      endMs: null,
      vadCancelled: false,
      completedBeforeSpeech,
      outputCleared: false,
      transcriptEmpty: false,
    }
    return true
  }

  private canBegin(responseId: string | null, allowed: boolean): responseId is string {
    if (this.disabled || !allowed || !responseId) return false
    return !this.closedResponses.has(responseId)
  }

  responseDone(frame: Extract<RealtimeFrame, { type: "turn_done" }>): boolean {
    const candidate = this.candidate
    if (!candidate || frame.responseId !== candidate.responseId) return false
    candidate.vadCancelled = frame.status === "cancelled" && frame.cancellationReason === "turn_detected"
    if (!candidate.vadCancelled) this.forbid()
    return true
  }

  outputCleared(frame: Extract<RealtimeFrame, { type: "output_cleared" }>): void {
    const candidate = this.candidate
    if (candidate && candidate.responseId === frame.responseId) candidate.outputCleared = true
  }

  speechStopped(frame: Extract<RealtimeFrame, { type: "speech_stopped" }>): void {
    const candidate = this.candidate
    if (!candidate || candidate.userItemId !== frame.itemId) return
    candidate.endMs = frame.audioEndMs ?? null
  }

  transcript(itemId: string | undefined, text: string): InterruptedTranscriptDecision | null {
    const candidate = this.candidate
    if (!candidate) return null
    if (!itemId || itemId !== candidate.userItemId) {
      this.forbid()
      return null
    }
    if (text.trim()) {
      this.resolve(false)
      return "respond"
    }
    candidate.transcriptEmpty = true
    return this.takeContinuation() ? "continue" : "pending"
  }

  takeContinuation(): boolean {
    const candidate = this.candidate
    if (!candidate?.transcriptEmpty) return false
    const speechMs = this.speechMs(candidate)
    const safe = (candidate.vadCancelled || candidate.completedBeforeSpeech)
      && candidate.outputCleared
      && speechMs !== null
      && speechMs <= FALSE_START_MAX_MS
    if (!safe) return false
    this.resolve(true)
    return true
  }

  transcriptionFailed(itemId: string | undefined): void {
    if (this.candidate && (!itemId || itemId === this.candidate.userItemId)) this.resolve(false)
  }

  newerResponse(responseId: string | undefined): void {
    if (this.candidate && responseId !== this.candidate.responseId) this.forbid()
  }

  newerSpeech(itemId: string | undefined): void {
    if (this.candidate && itemId !== this.candidate.userItemId) this.forbid()
  }

  forbid(): void {
    if (this.candidate) this.resolve(false)
  }

  disqualify(responseId: string | null): void {
    if (responseId) this.closedResponses.add(responseId)
    this.forbid()
  }

  disable(): void {
    this.disabled = true
    this.forbid()
  }

  private speechMs(candidate: Candidate): number | null {
    if (candidate.startMs === null || candidate.endMs === null || candidate.endMs < candidate.startMs) return null
    return candidate.endMs - candidate.startMs
  }

  private resolve(recovered: boolean): void {
    const candidate = this.candidate
    if (!candidate) return
    this.candidate = null
    this.closedResponses.add(candidate.responseId)
    this.report({
      kind: "speech_interruption",
      vadType: this.vadType,
      cancelledBy: "provider",
      recovered,
      speechMs: this.speechMs(candidate),
    })
  }
}

interface InterruptionDriverState {
  responding: boolean
  activeResponseId: string | null
  playbackResponseId: string | null
  completedResponseId: string | null
  outstanding: number
  owed: boolean
  interrupted: boolean
  recovery: FalseStartRecovery
}

function startInterruption(
  driver: InterruptionDriverState,
  frame: Extract<RealtimeFrame, { type: "speech_started" }>,
): void {
  if (driver.responding || driver.playbackResponseId) {
    const responseId = driver.playbackResponseId ?? driver.activeResponseId
    driver.recovery.begin(
      frame,
      responseId,
      !driver.responding && driver.completedResponseId === responseId,
      driver.outstanding === 0,
    )
    driver.owed = false
    driver.interrupted = true
  } else {
    driver.recovery.newerSpeech(frame.itemId)
  }
}

function handleOutputFrame(
  driver: InterruptionDriverState,
  frame: RealtimeFrame,
  continueResponse: () => void,
): boolean {
  if (frame.type === "output_started") {
    driver.playbackResponseId = frame.responseId ?? null
    return true
  }
  if (frame.type === "output_stopped") {
    if (!frame.responseId || driver.playbackResponseId === frame.responseId) driver.playbackResponseId = null
    return true
  }
  if (frame.type !== "output_cleared") return false
  if (!frame.responseId || driver.playbackResponseId === frame.responseId) driver.playbackResponseId = null
  driver.recovery.outputCleared(frame)
  if (driver.recovery.takeContinuation()) continueResponse()
  return true
}

/** Own the VAD-only branch so the main conversation driver stays focused on
 * responses and tools. */
export function handleInterruptionFrame(
  driver: InterruptionDriverState,
  frame: RealtimeFrame,
  settleProactive: () => void,
  show: (state: "listening" | "thinking") => void,
  continueResponse: () => void,
): boolean {
  if (handleOutputFrame(driver, frame, continueResponse)) return true
  switch (frame.type) {
    case "speech_started":
      startInterruption(driver, frame)
      settleProactive()
      show("listening")
      return true
    case "speech_stopped":
      driver.recovery.speechStopped(frame)
      if (driver.recovery.takeContinuation()) continueResponse()
      show("thinking")
      return true
    case "transcript_failed":
      driver.recovery.transcriptionFailed(frame.itemId)
      return true
    default:
      return false
  }
}
