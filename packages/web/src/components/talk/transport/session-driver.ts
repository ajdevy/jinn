/**
 * What the browser says to the provider, and what it does with what comes back.
 *
 * This is the conversation loop with React taken out of it: frames in, tool
 * calls run, turns priced, orb state reported. It holds only what a turn needs
 * — the running usage total, the last thing the assistant said, and which tool
 * calls and responses are still open — so `use-talk-session.ts` is left with
 * lifecycle alone.
 */
import { executeToolCall, toolDefinitions } from "../tools/registry"
import type { OrbState } from "../orb-motion"
import { createFrameReader, type RealtimeFrame } from "./realtime-events"
import { postTalkTurn } from "./session-client"
import { emptyTalkUsage, usageDelta, type TalkUsage } from "./usage-delta"

export interface TalkDriverOptions {
  sessionId: string
  /** Send one client event over the `oai-events` data channel. */
  send: (event: Record<string, unknown>) => void
  onState: (state: OrbState) => void
  onError: (message: string) => void
}

export interface TalkDriver {
  /** Declare the tool catalog. Called once, when the channel opens. */
  start: () => void
  /** Handle one raw data-channel frame. */
  receive: (data: string) => void
}

/**
 * The provider's tool declaration is a function tool: `{ type: "function" }`
 * around the same `{ name, description, parameters }` the registry already
 * exports, which is exactly what the gateway's own adapter sends
 * (`buildSessionPayload` in talk/realtime/openai.ts).
 *
 * It is the WEB catalog that goes out, not the gateway's. The two share no tool
 * name at all, and only these have an executor in the browser — a session
 * configured from the gateway's list could emit nothing this page can run.
 */
function functionTools() {
  return toolDefinitions().map((tool) => ({ type: "function", ...tool }))
}

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

  const result = await executeToolCall(call.name, call.arguments)
  driver.options.send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
  })

  driver.outstanding -= 1
  if (driver.outstanding === 0) requestResponse(driver)
}

/** Price the turn and clear what was said, so the next turn cannot re-post it. */
function finishTurn(driver: DriverState, total: TalkUsage): void {
  const delta = usageDelta(driver.billed, total)
  driver.billed = total
  const transcript = driver.said
  driver.said = ""
  show(driver, "listening")
  void postTalkTurn(driver.options.sessionId, delta, transcript).catch(() => {
    // Accounting must not interrupt a conversation. An unposted turn
    // under-reports spend; a thrown one would drop the rest of the exchange.
  })
}

/**
 * The response is over: price it, then make the one request it was owed.
 *
 * Unless one of its tool calls is still running. That call is the last to
 * answer, so it is the one that asks — asking here as well would put a second
 * `response.create` on the same utterance, which is the duplicate reply.
 */
function endResponse(driver: DriverState, total: TalkUsage): void {
  driver.responding = false
  finishTurn(driver, total)
  if (driver.owed && driver.outstanding === 0) requestResponse(driver)
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
      endResponse(driver, frame.usage)
      return
    case "transcript":
      // The operator's own transcript is not the orb talking.
      if (frame.role !== "assistant") return
      show(driver, "speaking")
      if (frame.final) driver.said = frame.text
      return
    case "speech_started":
      show(driver, "listening")
      return
    case "speech_stopped":
      show(driver, "thinking")
      return
    case "error":
      driver.options.onError(frame.message)
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
  }
  const read = createFrameReader()
  return {
    start: () => options.send({ type: "session.update", session: { type: "realtime", tools: functionTools() } }),
    receive: (data: string) => {
      const frame = read(data)
      if (frame) handle(driver, frame)
    },
  }
}
