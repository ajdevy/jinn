/**
 * What the browser says to the provider, and what it does with what comes back.
 *
 * This is the conversation loop with React taken out of it: frames in, tool
 * calls run, turns priced, orb state reported. It holds only what a turn needs
 * — the running usage total, the last thing the assistant said, and which tool
 * calls and responses are still open — so `use-talk-session.ts` is left with
 * lifecycle alone.
 */
import { describeInstance } from "../context/instance-identity"
import { getPageContext, subscribePageContext } from "../context/page-context-store"
import { renderPageContext } from "../context/render-page-context"
import { visibleObjects } from "../context/visible-objects"
import type { OrbState } from "../orb-motion"
import { persistOperatorTranscript, type OperatorTranscriptEvidence } from "./operator-transcript-evidence"
import { createFrameReader, type RealtimeFrame } from "./realtime-events"
import { postTalkScreenContext } from "./session-client"
import { emptyTalkUsage, usageDelta, type TalkUsage } from "./usage-delta"
import { createVisualCapture, type VisualCaptureReceipt } from "../context/visual-capture"
import { functionTools, type TalkControlManifest } from "./control-manifest"
import type { TalkUiEffect } from "./ui-effects"
import { executeTalkTool } from "./tool-call-executor"
import { recordSettledTurn } from "./turn-recorder"

/**
 * How long the page has to settle before the orb is told about it. Typing in the
 * board's search box rewrites the URL on every keystroke, and a push per
 * keystroke would be a `session.update` per keystroke.
 */
export const PAGE_CONTEXT_DEBOUNCE_MS = 400
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
  /** How this driver lets go of the page store, and the push it is currently
   *  waiting out the debounce on. Both live exactly as long as the connection. */
  unfollow: (() => void) | null
  settling: ReturnType<typeof setTimeout> | null
  lastUserRequestKey: string | null
  lastUserEvidence: OperatorTranscriptEvidence | null
  visualReceipts: VisualCaptureReceipt[]
  visualCapture: ReturnType<typeof createVisualCapture>
}
/**
 * Declare the session: the tool catalog, what this instance is, and where the
 * operator is.
 *
 * The tools ride along on every push rather than leaning on the provider to
 * merge one field at a time. `instructions` is a replaced field, and a context
 * push that silently cleared the tool list would take the whole orb down — the
 * extra bytes are on a local data channel and cost nothing worth having.
 *
 * The brief is re-sent for the same reason, and it leads: it is the standing
 * half, and the page underneath it is what changes. A push that carried only
 * the page would erase everything the orb knows about the company.
 */
function sendSessionConfig(driver: DriverState): void {
  const page = getPageContext()
  const context = renderPageContext(page, visibleObjects(page), describeInstance())
  const brief = driver.options.brief
  const memory = driver.options.topicMemory ? `Talk topic memory: ${driver.options.topicMemory}` : ""
  if (driver.options.browserInstanceId && driver.options.credentialGeneration) {
    void postTalkScreenContext(driver.options.sessionId, page, driver.options.browserInstanceId,
      driver.options.credentialGeneration).catch(() => {})
  }
  driver.options.send({
    type: "session.update",
    session: {
      type: "realtime",
      tools: functionTools(driver.options.manifest),
      instructions: [brief, memory, context].filter(Boolean).join("\n\n"),
    },
  })
}

/** Follow the page, one push per settled change. */
function followPage(driver: DriverState): void {
  driver.unfollow = subscribePageContext(() => {
    if (driver.settling) clearTimeout(driver.settling)
    driver.settling = setTimeout(() => {
      driver.settling = null
      sendSessionConfig(driver)
    }, PAGE_CONTEXT_DEBOUNCE_MS)
  })
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
      applyUiEffect: driver.options.applyUiEffect,
    })
  } catch {
    result = { ok: false, error: "The verified Talk control could not be completed." }
  }
  driver.options.send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
  })

  driver.outstanding -= 1
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
  if (driver.owed && driver.outstanding === 0) requestResponse(driver)
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
      show(driver, "listening")
      return
    case "speech_stopped":
      show(driver, "thinking")
      return
    case "error":
      driver.options.onError(frame.message)
      return
    case "item_created":
      return
  }
}

export function createTalkDriver(options: TalkDriverOptions): TalkDriver {
  const driver: DriverState = {
    options,
    billed: emptyTalkUsage(),
    said: "",
    state: "listening",
    executed: new Set(),
    outstanding: 0,
    responding: false,
    owed: false,
    unfollow: null,
    settling: null,
    lastUserRequestKey: null,
    lastUserEvidence: null,
    visualReceipts: [],
    visualCapture: options.visualCapture ?? createVisualCapture(),
  }
  const read = createFrameReader()
  return {
    start: () => {
      sendSessionConfig(driver)
      followPage(driver)
    },
    receive: (data: string) => {
      const frame = read(data)
      if (frame) handle(driver, frame)
    },
    stop: () => {
      driver.unfollow?.()
      driver.unfollow = null
      if (driver.settling) clearTimeout(driver.settling)
      driver.settling = null
    },
  }
}
