import type { ChatBlockEnvelope, JsonObject } from "./types.js"

export interface SessionDeliveryIdentity {
  targetSessionId: string
  sourceKind: "session" | "workflow-run" | "heartbeat" | "work-item"
  sourceId: string
  sourceAttempt: string
  sourceOutcome: string
  sourceVersion: number
  deliveryKind: string
}

export interface SessionDeliveryPayload {
  message: string
  displayMessage: string
  meta?: JsonObject
  block?: ChatBlockEnvelope
}

export interface SessionDelivery extends SessionDeliveryIdentity {
  id: string
  payload: SessionDeliveryPayload
  status: "pending" | "accepted" | "dead_letter"
  messageId: string | null
  queueItemId: string | null
  attemptCount: number
  nextAttemptAt: number | null
  lastAttemptAt: number | null
  lastError: string | null
  deadLetteredAt: number | null
  createdAt: string
  acceptedAt: string | null
}

/** Operator-facing dead-letter diagnostics for rows whose payload is unsafe. */
export interface SessionDeliveryDeadLetter extends Omit<SessionDelivery, "payload"> {
  payload: SessionDeliveryPayload | null
  payloadError: string | null
}
