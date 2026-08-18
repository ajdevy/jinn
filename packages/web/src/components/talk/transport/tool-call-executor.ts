import { createVisualCapture, type VisualCaptureReceipt } from "../context/visual-capture"
import { executeToolCall } from "../tools/registry"
import type { RealtimeFrame } from "./realtime-events"
import { postTalkControlCall } from "./session-client"
import { operationByName, type TalkControlManifest } from "./control-manifest"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { runVisualToolRequest } from "./visual-tool-request"

interface TalkToolExecutionOptions {
  sessionId: string
  manifest: TalkControlManifest
  requestKey: string | null
  capture: ReturnType<typeof createVisualCapture>
  receipts: VisualCaptureReceipt[]
  send: (event: Record<string, unknown>) => void
  applyUiEffect?: (effect: TalkUiEffect | null) => Promise<void>
}

export async function executeTalkTool(
  call: Extract<RealtimeFrame, { type: "tool_call" }>,
  options: TalkToolExecutionOptions,
): Promise<Record<string, unknown>> {
  const operation = operationByName(options.manifest, call.name)
  if (!operation) return { ok: false, error: `The Talk manifest does not declare ${call.name}.` }
  if (operation.target === "gateway") {
    const result = await postTalkControlCall(options.sessionId, {
      providerCallId: call.callId,
      ...(call.itemId ? { providerItemId: call.itemId } : {}),
      tool: call.name,
      arguments: call.arguments,
    })
    if (result.ok) await (options.applyUiEffect ?? applyTalkUiEffect)(result.uiEffect)
    return result
  }
  if (call.name === "capture_current_view") {
    return runVisualToolRequest({
      arguments: call.arguments,
      requestKey: options.requestKey,
      capture: options.capture,
      send: options.send,
      receipts: options.receipts,
    })
  }
  return executeToolCall(call.name, call.arguments)
}
