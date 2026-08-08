/**
 * What the browser says to the provider, and what it does with what comes back.
 *
 * This is the conversation loop with React taken out of it: frames in, tool
 * calls run, turns priced, orb state reported. It holds the two pieces of state
 * a turn needs — the running usage total and the last thing the assistant said
 * — and nothing else, so `use-talk-session.ts` is left with lifecycle alone.
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
 *  assistant last said, and what the orb is currently showing. */
interface DriverState {
  options: TalkDriverOptions
  billed: TalkUsage
  said: string
  state: OrbState
}

function show(driver: DriverState, next: OrbState): void {
  if (next === driver.state) return
  driver.state = next
  driver.options.onState(next)
}

/**
 * Answer the model, whatever the tool did. `executeToolCall` returns a value for
 * every failure too, so there is always something to send back — a call left
 * unanswered stalls the turn.
 */
async function runTool(driver: DriverState, call: Extract<RealtimeFrame, { type: "tool_call" }>): Promise<void> {
  const result = await executeToolCall(call.name, call.arguments)
  driver.options.send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
  })
  driver.options.send({ type: "response.create" })
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

function handle(driver: DriverState, frame: RealtimeFrame): void {
  switch (frame.type) {
    case "tool_call":
      void runTool(driver, frame)
      return
    case "turn_done":
      finishTurn(driver, frame.usage)
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
  const driver: DriverState = { options, billed: emptyTalkUsage(), said: "", state: "listening" }
  const read = createFrameReader()
  return {
    start: () => options.send({ type: "session.update", session: { type: "realtime", tools: functionTools() } }),
    receive: (data: string) => {
      const frame = read(data)
      if (frame) handle(driver, frame)
    },
  }
}
