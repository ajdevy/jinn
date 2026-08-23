/**
 * What the browser says to the provider, and what it does with what comes back.
 *
 * This is the conversation loop with React taken out of it: frames in, tool
 * calls run, turns priced, orb state reported. It holds only what a turn needs
 * — the running usage total, the last thing the assistant said, and which tool
 * calls and responses are still open — so `use-talk-session.ts` is left with
 * lifecycle alone.
 */
import type { OrbState } from "../orb-motion"
import { persistOperatorTranscript } from "./operator-transcript-evidence"
import { createFrameReader, type RealtimeFrame } from "./realtime-events"
import { emptyTalkUsage, usageDelta } from "./usage-delta"
import { createVisualCapture } from "../context/visual-capture"
import type { TalkControlManifest } from "./control-manifest"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { executeTalkTool } from "./tool-call-executor"
import { recordSettledTurn } from "./turn-recorder"
import { createSessionContextBridge } from "./session-context-bridge"
import { DriverProactiveCues, type ProactiveCueSettled } from "./driver-proactive-cues"
import { FalseStartRecovery, handleInterruptionFrame, sendFalseStartContinuation,
  type InterruptionTelemetry } from "./false-start-recovery"
import type { DriverState } from "./driver-state"
export { PAGE_CONTEXT_DEBOUNCE_MS } from "./session-context-bridge"
export interface TalkDriverOptions {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
  /** What this instance is, as the gateway described it when the session opened
   *  — the company, its conventions, and who works here. Absent on a session
   *  opened against a gateway that does not send one. */
  brief?: string
  topicMemory?: string
  manifest: TalkControlManifest
  /** Send one client event over the `oai-events` data channel. */
  send: (event: Record<string, unknown>) => void
  onState: (state: OrbState) => void
  onError: (message: string) => void
  vadType?: InterruptionTelemetry["vadType"]
  onInterruption?: (event: InterruptionTelemetry) => void
  visualCapture?: ReturnType<typeof createVisualCapture>
  applyUiEffect?: (effect: TalkUiEffect | null) => Promise<void>
}

export interface TalkDriver {
  /** Declare the tool catalog and the page, and start following the page.
   *  Called once, when the channel opens. */
  start: () => void
  /** Handle one raw data-channel frame. */
  receive: (data: string) => void
  /** Speak one server-authorized urgent cue. Receipt identity is retained for
   *  this attachment so a replay cannot produce a second response. */
  cue: (summary: string, receiptId: string, settled: ProactiveCueSettled) => boolean
  /** Stop following the page. Called wherever the connection is dropped — a
   *  driver that outlived its channel would keep pushing context at nothing. */
  stop: () => void
}
function show(driver: DriverState, next: OrbState): void {
  if (next === driver.state) return
  driver.state = next
  driver.options.onState(next)
}
function requestResponse(driver: DriverState): void {
  if (driver.interrupted) return
  if (driver.responding || driver.outstanding > 0) {
    driver.owed = true
    return
  }
  driver.owed = false
  driver.options.send({ type: "response.create" })
}

function continueResponse(driver: DriverState): void {
  driver.interrupted = false
  sendFalseStartContinuation(driver.options.send)
}

/**
 * Answer the model, whatever the tool did. `executeToolCall` returns a value for
 * every failure too, so there is always something to send back — a call left
 * unanswered stalls the turn.
 *
 * A `call_id` runs once and only once. One response can carry several calls, and
 * the reply is asked for when the last of them has answered, so an utterance
 * that took three tools is still one spoken reply.
 */
async function runTool(driver: DriverState, call: Extract<RealtimeFrame, { type: "tool_call" }>): Promise<void> {
  if (driver.executed.has(call.callId)) return
  driver.recovery.disqualify(driver.activeResponseId ?? driver.playbackResponseId)
  driver.executed.add(call.callId)
  driver.outstanding += 1

  let result: Record<string, unknown>
  try {
    result = await executeTalkTool(call, {
      sessionId: driver.options.sessionId,
      browserInstanceId: driver.options.browserInstanceId,
      credentialGeneration: driver.options.credentialGeneration,
      operatorTranscript: driver.lastUserEvidence,
      manifest: driver.options.manifest,
      requestKey: driver.lastUserRequestKey,
      capture: driver.visualCapture,
      receipts: driver.visualReceipts,
      send: driver.options.send,
      applyUiEffect: async (effect) => {
        if (driver.stopped) return
        await (driver.options.applyUiEffect ?? applyTalkUiEffect)(effect)
      },
    })
  } catch {
    result = { ok: false, error: "The verified Talk control could not be completed." }
  }
  driver.outstanding -= 1
  if (driver.stopped) return
  driver.options.send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
  })

  if (driver.outstanding === 0) requestResponse(driver)
}

/** Price the turn and clear what was said, so the next turn cannot re-post it. */
function finishTurn(driver: DriverState, frame: Extract<RealtimeFrame, { type: "turn_done" }>): void {
  const total = frame.usage
  const delta = usageDelta(driver.billed, total)
  driver.billed = total
  const transcript = driver.said
  const visualReceipts = driver.visualReceipts.splice(0)
  driver.said = ""
  show(driver, "listening")
  recordSettledTurn({ sessionId: driver.options.sessionId, usage: delta, transcript, visualReceipts, frame,
    after: driver.lastUserEvidence?.persisted })
}

function endResponse(driver: DriverState, frame: Extract<RealtimeFrame, { type: "turn_done" }>): void {
  const interruptedResponse = driver.recovery.responseDone(frame)
  driver.responding = false
  driver.activeResponseId = null
  driver.completedResponseId = frame.status === "completed" ? frame.responseId ?? null : null
  finishTurn(driver, frame)
  if (driver.recovery.takeContinuation()) {
    continueResponse(driver)
    return
  }
  if (frame.status === "cancelled") {
    if (driver.owed && driver.outstanding === 0) requestResponse(driver)
    return
  }
  if (interruptedResponse) return
  driver.proactive.settle("completed")
  if (driver.owed && driver.outstanding === 0) requestResponse(driver)
  else driver.proactive.flush()
}

function answerUserTranscript(driver: DriverState, frame: Extract<RealtimeFrame, { type: "transcript" }>): void {
  if (!frame.final || !frame.itemId || driver.handledUserItems.has(frame.itemId)) return
  driver.handledUserItems.add(frame.itemId)
  const decision = driver.recovery.transcript(frame.itemId, frame.text)
  if (decision === "continue") {
    continueResponse(driver)
  } else if (decision === "respond" || (decision === null && frame.text.trim())) {
    driver.interrupted = false
    requestResponse(driver)
  }
}

function handleTranscript(driver: DriverState, frame: Extract<RealtimeFrame, { type: "transcript" }>): void {
  if (frame.role === "user") {
    if (frame.final && frame.itemId) driver.lastUserRequestKey = frame.itemId
    driver.lastUserEvidence = persistOperatorTranscript(frame, driver.options) ?? driver.lastUserEvidence
    answerUserTranscript(driver, frame)
    return
  }
  show(driver, "assistant_speaking")
  if (frame.final) driver.said = frame.text
}

function handle(driver: DriverState, frame: RealtimeFrame): void {
  if (handleInterruptionFrame(
    driver,
    frame,
    () => driver.proactive.settle("interrupted"),
    (state) => show(driver, state),
    () => continueResponse(driver),
  )) return
  switch (frame.type) {
    case "tool_call":
      void runTool(driver, frame)
      return
    case "turn_started":
      driver.recovery.newerResponse(frame.responseId)
      driver.interrupted = false
      driver.responding = true
      driver.activeResponseId = frame.responseId ?? null
      driver.completedResponseId = null
      // Whatever was owed, this response carries: it was created after those
      // outputs were appended, so it already speaks them.
      driver.owed = false
      // A response exists but nothing is being spoken yet: that gap is what
      // thinking means, and it is what the operator sees between letting go of
      // a sentence and hearing the answer begin.
      show(driver, "thinking")
      return
    case "turn_done":
      endResponse(driver, frame)
      return
    case "transcript":
      handleTranscript(driver, frame)
      return
    case "error":
      driver.recovery.disqualify(driver.activeResponseId ?? driver.playbackResponseId)
      show(driver, "error")
      driver.options.onError(frame.message)
      return
    case "item_created":
      return
  }
}

export function createTalkDriver(options: TalkDriverOptions): TalkDriver {
  let driver: DriverState
  const proactive = new DriverProactiveCues(options.send, () => show(driver, "thinking"))
  const recovery = new FalseStartRecovery(options.vadType ?? "server_vad", options.onInterruption ?? (() => {}))
  driver = {
    options,
    billed: emptyTalkUsage(),
    said: "",
    state: "listening",
    executed: new Set(),
    outstanding: 0,
    responding: false,
    owed: false,
    interrupted: false,
    activeResponseId: null,
    playbackResponseId: null,
    completedResponseId: null,
    handledUserItems: new Set(),
    stopped: false,
    lastUserRequestKey: null,
    lastUserEvidence: null,
    visualReceipts: [],
    visualCapture: options.visualCapture ?? createVisualCapture(),
    proactive,
    recovery,
  }
  const read = createFrameReader()
  const context = createSessionContextBridge(options)
  return {
    start: context.start,
    receive: (data: string) => {
      const frame = read(data)
      if (frame) handle(driver, frame)
    },
    cue: (summary, receiptId, settled) => {
      driver.recovery.disqualify(driver.activeResponseId ?? driver.playbackResponseId)
      return driver.proactive.accept(summary, receiptId, settled, driver.responding || driver.outstanding > 0)
    },
    stop: () => {
      driver.stopped = true
      driver.recovery.disable()
      driver.proactive.stop()
      context.stop()
    },
  }
}
