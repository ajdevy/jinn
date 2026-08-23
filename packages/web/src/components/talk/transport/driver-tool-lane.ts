/**
 * Running one tool call, and deciding when the model is owed a reply.
 *
 * The bookkeeping a turn needs around `executeTalkTool`: a `call_id` runs once,
 * several calls in one response still produce one spoken reply, and the model
 * is always answered — a call left unanswered stalls the turn.
 */
import { applyTalkUiEffect } from "./ui-effects"
import { executeTalkTool } from "./tool-call-executor"
import { sendFalseStartContinuation } from "./false-start-recovery"
import type { RealtimeFrame } from "./realtime-events"
import type { DriverState } from "./driver-state"

export function requestResponse(driver: DriverState): void {
  if (driver.interrupted) return
  if (driver.responding || driver.outstanding > 0) {
    driver.owed = true
    return
  }
  driver.owed = false
  driver.options.send({ type: "response.create" })
}

export function continueResponse(driver: DriverState): void {
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
export async function runTool(driver: DriverState, call: Extract<RealtimeFrame, { type: "tool_call" }>): Promise<void> {
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
  } catch (failure) {
    // `executeTalkTool` answers every failure it can name, so reaching here is
    // a tool that threw outright — still reported in its own words.
    result = { ok: false, code: "tool-failed", error: failure instanceof Error ? failure.message : "The Talk control could not be completed." }
  }
  driver.outstanding -= 1
  if (driver.stopped) return
  driver.options.send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
  })

  if (driver.outstanding === 0) requestResponse(driver)
}
