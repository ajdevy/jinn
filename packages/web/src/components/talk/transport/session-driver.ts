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
import { recordSettledTurn } from "./turn-recorder"
import { createSessionContextBridge } from "./session-context-bridge"
import { DriverProactiveCues, type ProactiveCueSettled } from "./driver-proactive-cues"
import { FalseStartRecovery, handleInterruptionFrame } from "./false-start-recovery"
import type { DriverState, TalkDriverOptions } from "./driver-state"
import { continueResponse, requestResponse, runTool } from "./driver-tool-lane"
export type { TalkDriverOptions } from "./driver-state"
export { PAGE_CONTEXT_DEBOUNCE_MS } from "./session-context-bridge"

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
  show(driver, "speaking")
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
