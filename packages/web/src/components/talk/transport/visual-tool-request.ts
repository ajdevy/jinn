import { getPageContext } from "../context/page-context-store"
import type { createVisualCapture, VisualCaptureReceipt } from "../context/visual-capture"

interface VisualToolRequestOptions {
  arguments: string
  requestKey: string | null
  capture: ReturnType<typeof createVisualCapture>
  send: (event: Record<string, unknown>) => void
  receipts: VisualCaptureReceipt[]
}

function visualReason(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as { reason?: unknown }
    return typeof parsed.reason === "string" ? parsed.reason.trim() : ""
  } catch {
    return ""
  }
}

/** Run the one visual-only browser tool and keep its image receipt with the turn. */
export async function runVisualToolRequest(options: VisualToolRequestOptions): Promise<Record<string, unknown>> {
  const context = getPageContext()
  const root = document.getElementById("root")
  const reason = visualReason(options.arguments)
  if (!options.requestKey) {
    return { ok: false, code: "visual-utterance-unattributed", error: "No final operator utterance identifies this visual question." }
  }
  if (!root || !reason) {
    return { ok: false, code: "invalid-visual-request", error: "A visual request needs the declared reason and the current app root." }
  }

  const captured = await options.capture.request({
    context,
    reason,
    requestKey: options.requestKey,
    root,
  })
  if (!captured.ok) return captured
  options.send(captured.event)
  options.receipts.push(captured.receipt)
  return { ok: true, data: captured.receipt }
}
