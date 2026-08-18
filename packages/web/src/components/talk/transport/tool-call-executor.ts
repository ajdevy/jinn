import { createVisualCapture, type VisualCaptureReceipt } from "../context/visual-capture"
import { executeToolCall } from "../tools/registry"
import type { RealtimeFrame } from "./realtime-events"
import { postTalkControlCall, type TalkControlCall } from "./session-client"
import { operationByName, type TalkControlManifest } from "./control-manifest"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { runVisualToolRequest } from "./visual-tool-request"

interface TalkToolExecutionOptions {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
  operatorTranscript?: { itemId: string; eventId: string; persisted: Promise<void> } | null
  manifest: TalkControlManifest
  requestKey: string | null
  capture: ReturnType<typeof createVisualCapture>
  receipts: VisualCaptureReceipt[]
  send: (event: Record<string, unknown>) => void
  applyUiEffect?: (effect: TalkUiEffect | null) => Promise<void>
}

const APPROVAL_OPERATIONS = new Set(["prepare_voice_approval", "commit_voice_approval"])

function gatewayCall(call: Extract<RealtimeFrame, { type: "tool_call" }>, options: TalkToolExecutionOptions) {
  return Object.fromEntries(Object.entries({
    providerCallId: call.callId,
    providerItemId: call.itemId,
    providerEventId: call.eventId,
    providerTranscriptItemId: options.operatorTranscript?.itemId,
    browserInstanceId: options.browserInstanceId,
    credentialGeneration: options.credentialGeneration,
    tool: call.name,
    arguments: call.arguments,
  }).filter((entry) => entry[1] !== undefined)) as unknown as TalkControlCall
}

async function executeGatewayTool(
  call: Extract<RealtimeFrame, { type: "tool_call" }>,
  options: TalkToolExecutionOptions,
): Promise<Record<string, unknown>> {
  const hasApprovalIdentity = [options.browserInstanceId, options.credentialGeneration, options.operatorTranscript].every(Boolean)
  if (APPROVAL_OPERATIONS.has(call.name) && !hasApprovalIdentity) {
    return { ok: false, code: "credential-missing", error: "The active Talk credential identity is missing." }
  }
  if (options.operatorTranscript) await options.operatorTranscript.persisted
  const result = await postTalkControlCall(options.sessionId, gatewayCall(call, options))
  if (result.ok) await (options.applyUiEffect ?? applyTalkUiEffect)(result.uiEffect)
  return result
}

export async function executeTalkTool(
  call: Extract<RealtimeFrame, { type: "tool_call" }>,
  options: TalkToolExecutionOptions,
): Promise<Record<string, unknown>> {
  const operation = operationByName(options.manifest, call.name)
  if (!operation) return { ok: false, error: `The Talk manifest does not declare ${call.name}.` }
  if (operation.target === "gateway") return executeGatewayTool(call, options)
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
