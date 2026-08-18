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
import { persistOperatorTranscript, type OperatorTranscriptEvidence } from "./operator-transcript-evidence"
import { createFrameReader, type RealtimeFrame } from "./realtime-events"
import { emptyTalkUsage, usageDelta, type TalkUsage } from "./usage-delta"
import { createVisualCapture, type VisualCaptureReceipt } from "../context/visual-capture"
import type { TalkControlManifest } from "./control-manifest"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { executeTalkTool } from "./tool-call-executor"
import { recordSettledTurn } from "./turn-recorder"
import { createSessionContextBridge } from "./session-context-bridge"
import { DriverProactiveCues, type ProactiveCueSettled } from "./driver-proactive-cues"

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
/**
 * The provider receives the gateway-issued manifest projected into ordinary
 * function declarations. Target metadata stays in the driver and decides
 * whether a call runs as a bounded browser effect or through `/control`.
 */
/** Everything one live conversation remembers: what has been billed, what the
 *  assistant last said, what the orb is currently showing, and enough about the
 *  tool calls in flight to answer one utterance exactly once. */
interface DriverState {
  options: TalkDriverOptions
  billed: TalkUsage
  said: string
  state: OrbState
  /** Every `call_id` already dispatched. A provider that replays one must not
   *  make the browser write twice. It lives as long as the connection, which is
   *  the right scope: a park and resume builds a new driver, and no `call_id`
   *  outlives the response that issued it. */
  executed: Set<string>
  /** Tool calls still running. One response can carry several, and it is the
   *  last of them to answer that asks for the reply — not each of them. */
  outstanding: number
  /** True between `response.created` and `response.done`. The conversation
   *  holds one response at a time; asking during it is refused. */
  responding: boolean
  /** A tool answered while a response was in flight, so a request is still
   *  owed once that response ends. */
  owed: boolean
  /** The operator started speaking over the current response. Its tool effects
   *  may still settle (and are still answered once), but none of those late
   *  results may start another spoken response. A provider-created response
   *  for the new utterance clears this fence. */
  interrupted: boolean
  proactive: DriverProactiveCues
  stopped: boolean
  lastUserRequestKey: string | null
  lastUserEvidence: OperatorTranscriptEvidence | null
  visualReceipts: VisualCaptureReceipt[]
  visualCapture: ReturnType<typeof createVisualCapture>
}
function show(driver: DriverState, next: OrbState): void {
  if (next === driver.state) return
  driver.state = next
  driver.options.onState(next)
}
/**
 * Ask the assistant to speak, once the tool outputs are on the conversation.
 *
 * Held rather than dropped while a response is still going: the provider
 * refuses a second one, and dropping the ask would leave a tool result the
 * model never speaks — a silent stall, which is the worse of the two failures.
 */
function requestResponse(driver: DriverState): void {
  if (driver.interrupted) return
  if (driver.responding) {
    driver.owed = true
    return
  }
  driver.owed = false
  driver.options.send({ type: "response.create" })
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

/**
 * The response is over: price it, then make the one request it was owed.
 *
 * Unless one of its tool calls is still running. That call is the last to
 * answer, so it is the one that asks — asking here as well would put a second
 * `response.create` on the same utterance, which is the duplicate reply.
 */
function endResponse(driver: DriverState, frame: Extract<RealtimeFrame, { type: "turn_done" }>): void {
  driver.responding = false
  finishTurn(driver, frame)
  driver.proactive.settle("completed")
  if (driver.owed && driver.outstanding === 0) requestResponse(driver)
  else driver.proactive.flush()
}

function handleTranscript(driver: DriverState, frame: Extract<RealtimeFrame, { type: "transcript" }>): void {
  if (frame.role !== "assistant") {
    if (frame.final && frame.itemId) driver.lastUserRequestKey = frame.itemId
    driver.lastUserEvidence = persistOperatorTranscript(frame, driver.options) ?? driver.lastUserEvidence
    return
  }
  show(driver, "speaking")
  if (frame.final) driver.said = frame.text
}

function handle(driver: DriverState, frame: RealtimeFrame): void {
  switch (frame.type) {
    case "tool_call":
      void runTool(driver, frame)
      return
    case "turn_started":
      driver.interrupted = false
      driver.responding = true
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
    case "speech_started":
      if (driver.responding) {
        driver.options.send({ type: "response.cancel" })
        driver.responding = false
        driver.owed = false
        driver.interrupted = true
      }
      driver.proactive.settle("interrupted")
      show(driver, "listening")
      return
    case "speech_stopped":
      show(driver, "thinking")
      return
    case "error":
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
    stopped: false,
    lastUserRequestKey: null,
    lastUserEvidence: null,
    visualReceipts: [],
    visualCapture: options.visualCapture ?? createVisualCapture(),
    proactive,
  }
  const read = createFrameReader()
  const context = createSessionContextBridge(options)
  return {
    start: context.start,
    receive: (data: string) => {
      const frame = read(data)
      if (frame) handle(driver, frame)
    },
    cue: (summary, receiptId, settled) => driver.proactive.accept(
      summary,
      receiptId,
      settled,
      driver.responding || driver.outstanding > 0,
    ),
    stop: () => {
      driver.stopped = true
      driver.proactive.stop()
      context.stop()
    },
  }
}
