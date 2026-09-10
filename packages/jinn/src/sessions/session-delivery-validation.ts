import type {
  SessionDelivery,
  SessionDeliveryIdentity,
  SessionDeliveryPayload,
} from "../shared/types.js"

export interface SessionDeliveryRow {
  id: string
  targetSessionId: string
  sourceKind: SessionDeliveryIdentity["sourceKind"]
  sourceId: string
  sourceAttempt: string
  sourceOutcome: string
  sourceVersion: number
  deliveryKind: string
  payload: string
  status: SessionDelivery["status"]
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

export function canonicalCallbackIdentityText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFC").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    : ""
}

function assertIdentityFields(row: SessionDeliveryRow, canonical: SessionDeliveryIdentity): void {
  for (const field of ["targetSessionId", "sourceId", "sourceAttempt", "sourceOutcome", "deliveryKind"] as const) {
    if (row[field] !== canonical[field]) throw new Error(`Callback delivery ${row.id} has noncanonical ${field}`)
  }
  if (!Number.isInteger(row.sourceVersion) || row.sourceVersion < 1) throw new Error(`Session delivery ${row.id} has an invalid source version`)
  if (!["session", "workflow-run", "heartbeat", "work-item"].includes(row.sourceKind)) throw new Error(`Session delivery ${row.id} has an invalid source kind`)
}

function assertStatusFields(row: SessionDeliveryRow): void {
  if (!["pending", "accepted", "dead_letter"].includes(row.status)) throw new Error(`Callback delivery ${row.id} has an invalid lifecycle status`)
  if (!Number.isInteger(row.attemptCount) || row.attemptCount < 0) throw new Error(`Callback delivery ${row.id} has an invalid attempt count`)
}

function assertDateFields(row: SessionDeliveryRow): void {
  for (const [field, value] of Object.entries({ nextAttemptAt: row.nextAttemptAt, lastAttemptAt: row.lastAttemptAt, deadLetteredAt: row.deadLetteredAt })) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error(`Callback delivery ${row.id} has an invalid ${field}`)
  }
  if (typeof row.createdAt !== "string" || !row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(`Callback delivery ${row.id} has an invalid createdAt`)
  if (row.acceptedAt !== null && !Number.isFinite(Date.parse(row.acceptedAt))) throw new Error(`Callback delivery ${row.id} has an invalid acceptedAt`)
}

function assertMetadataFields(row: SessionDeliveryRow): void {
  for (const [field, value] of Object.entries({ messageId: row.messageId, queueItemId: row.queueItemId, acceptedAt: row.acceptedAt, lastError: row.lastError })) {
    if (value !== null && (typeof value !== "string" || value.length === 0)) throw new Error(`Callback delivery ${row.id} has an invalid ${field}`)
  }
}

function assertTemporalOrder(row: SessionDeliveryRow, createdAtMs: number, acceptedAtMs: number | null): void {
  if (acceptedAtMs !== null && acceptedAtMs < createdAtMs) throw new Error(`Callback delivery ${row.id} has acceptedAt before createdAt`)
  if (row.deadLetteredAt !== null && row.deadLetteredAt < createdAtMs) throw new Error(`Callback delivery ${row.id} has deadLetteredAt before createdAt`)
  if (row.lastError !== null && row.lastError.trim() === "") throw new Error(`Callback delivery ${row.id} has an empty lastError`)
}

function assertAttemptCount(row: SessionDeliveryRow): void {
  if (row.attemptCount === 0 && (row.nextAttemptAt !== null || row.lastAttemptAt !== null || row.lastError !== null)) throw new Error(`Callback delivery ${row.id} has attempt state without an attempt`)
  if (row.attemptCount > 0 && row.lastAttemptAt === null) throw new Error(`Callback delivery ${row.id} has an attempt without lastAttemptAt`)
  if (row.status === "pending" && row.attemptCount > 0 && row.nextAttemptAt === null) throw new Error(`Callback delivery ${row.id} has a pending attempt without nextAttemptAt`)
}

function assertAttemptTiming(row: SessionDeliveryRow, createdAtMs: number): void {
  if (row.lastAttemptAt !== null && row.lastAttemptAt < createdAtMs) throw new Error(`Callback delivery ${row.id} has lastAttemptAt before createdAt`)
  if (row.nextAttemptAt !== null && row.lastAttemptAt === null) throw new Error(`Callback delivery ${row.id} has nextAttemptAt without lastAttemptAt`)
  if (row.nextAttemptAt !== null && row.lastAttemptAt !== null && row.nextAttemptAt < row.lastAttemptAt) throw new Error(`Callback delivery ${row.id} has nextAttemptAt before lastAttemptAt`)
}

function assertAcceptedLifecycle(row: SessionDeliveryRow, acceptedAtMs: number | null): void {
  if (!row.messageId || !row.queueItemId || !row.acceptedAt || row.nextAttemptAt !== null || row.lastError !== null || row.deadLetteredAt !== null) throw new Error(`Callback delivery ${row.id} has an invalid accepted lifecycle`)
  if (acceptedAtMs !== null && row.lastAttemptAt !== null && acceptedAtMs < row.lastAttemptAt) throw new Error(`Callback delivery ${row.id} has acceptedAt before lastAttemptAt`)
}

function assertDeadLetterLifecycle(row: SessionDeliveryRow): void {
  if (row.deadLetteredAt === null || row.nextAttemptAt !== null || !row.lastError) throw new Error(`Callback delivery ${row.id} has an invalid dead-letter lifecycle`)
  if (row.lastAttemptAt !== null && row.deadLetteredAt < row.lastAttemptAt) throw new Error(`Callback delivery ${row.id} has deadLetteredAt before lastAttemptAt`)
}

function assertPendingLifecycle(row: SessionDeliveryRow): void {
  if (row.deadLetteredAt !== null) throw new Error(`Callback delivery ${row.id} has dead-letter state while pending`)
  if (row.lastError !== null && row.nextAttemptAt === null) throw new Error(`Callback delivery ${row.id} has retry error without nextAttemptAt`)
}

function assertLifecycleFields(row: SessionDeliveryRow, acceptedAtMs: number | null): void {
  if (row.status === "accepted") assertAcceptedLifecycle(row, acceptedAtMs)
  else if (row.messageId !== null || row.queueItemId !== null || row.acceptedAt !== null) throw new Error(`Callback delivery ${row.id} has callback acceptance state before acceptance`)
  if (row.status === "dead_letter") {
    assertDeadLetterLifecycle(row)
  }
  if (row.status === "pending") assertPendingLifecycle(row)
}

function parsePayload(row: SessionDeliveryRow): SessionDeliveryPayload {
  let payload: SessionDeliveryPayload
  try {
    payload = JSON.parse(row.payload) as SessionDeliveryPayload
  } catch {
    throw new Error(`Callback delivery ${row.id} has invalid payload JSON`)
  }
  if (!payload || typeof payload !== "object" || typeof payload.message !== "string" || typeof payload.displayMessage !== "string") throw new Error(`Callback delivery ${row.id} has an invalid payload`)
  return payload
}

export function sessionDeliveryFromRow(row: SessionDeliveryRow): SessionDelivery {
  if (row.deliveryKind === "quarantined" || row.sourceOutcome === "quarantined") throw new Error(`Session delivery ${row.id} is quarantined${row.lastError ? `: ${row.lastError}` : ""}`)
  const canonical = canonicalSessionDeliveryIdentity(row)
  validateSessionDeliveryIdentity(canonical)
  assertIdentityFields(row, canonical)
  assertStatusFields(row)
  assertDateFields(row)
  assertMetadataFields(row)
  const createdAtMs = Date.parse(row.createdAt)
  const acceptedAtMs = row.acceptedAt === null ? null : Date.parse(row.acceptedAt)
  assertTemporalOrder(row, createdAtMs, acceptedAtMs)
  assertAttemptCount(row)
  assertAttemptTiming(row, createdAtMs)
  assertLifecycleFields(row, acceptedAtMs)
  return { ...row, payload: parsePayload(row) }
}

export function canonicalSessionDeliveryIdentity(identity: SessionDeliveryIdentity): SessionDeliveryIdentity {
  return {
    targetSessionId: canonicalCallbackIdentityText(identity.targetSessionId),
    sourceKind: identity.sourceKind,
    sourceId: canonicalCallbackIdentityText(identity.sourceId),
    sourceAttempt: canonicalCallbackIdentityText(identity.sourceAttempt),
    sourceOutcome: canonicalCallbackIdentityText(identity.sourceOutcome),
    sourceVersion: identity.sourceVersion,
    deliveryKind: canonicalCallbackIdentityText(identity.deliveryKind),
  }
}

export function validateSessionDeliveryIdentity(identity: SessionDeliveryIdentity): void {
  for (const [name, value] of Object.entries({
    targetSessionId: identity.targetSessionId,
    sourceId: identity.sourceId,
    sourceAttempt: identity.sourceAttempt,
    sourceOutcome: identity.sourceOutcome,
    deliveryKind: identity.deliveryKind,
  })) {
    if (typeof value !== "string" || !canonicalCallbackIdentityText(value)) throw new Error(`${name} is required for session delivery`)
  }
  if (!["session", "workflow-run", "heartbeat", "work-item"].includes(identity.sourceKind)) throw new Error("sourceKind is invalid for session delivery")
  if (!Number.isInteger(identity.sourceVersion) || identity.sourceVersion < 1) throw new Error("sourceVersion must be a positive integer for session delivery")
}
