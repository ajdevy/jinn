/** The gateway → browser event protocol: the event map, its names, and the runtime that
 *  decodes a frame. The JSON-only shapes those events carry live in ./payloads.js. */
import type { CompanyChangedEvent, JsonObject, JsonValue, MessageMediaWire } from "./payloads.js"
export type * from "./payloads.js"

export interface GatewayEventMap {
  "session:started": { sessionId: string }
  "session:created": { sessionId: string }
  "session:updated": { sessionId: string; title?: string }
  "session:deleted": { sessionId: string }
  "session:stopped": { sessionId: string }
  "session:external-turn": { sessionId: string }
  "session:interrupted": { sessionId: string; reason: string }
  "session:completed": {
    sessionId: string
    result: string | null
    error: string | null
    employee?: string
    title?: string | null
    cost?: number
    durationMs?: number
  }
  "session:delta": {
    sessionId: string
    type: "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block"
    content: string
    toolName?: string
    toolId?: string
    activityReceiptId?: string
    input?: string
    block?: JsonValue
  }
  "session:notification": { sessionId: string; message: string; meta?: JsonObject }
  "session:attachment": { sessionId: string; id: string; content: string; media: MessageMediaWire[]; timestamp: number }
  "session:background": {
    sessionId: string
    transportState: string
    backgroundActivity: {
      activeStreams: number
      activeAgents?: number
      activeMonitors?: number
      lastActivityAt: string
    } | null
  }
  "queue:updated": { sessionId: string; sessionKey: string; depth?: number; paused?: boolean }
  "company:changed": CompanyChangedEvent
  "pins:changed": Record<string, never>
  "notes:changed": { path: string; revision: string; action: "created" | "updated" }
  "experiments:changed": {
    id: string
    action: "created" | "updated" | "reading-recorded" | "concluded"
  }
  "org:changed": Record<string, never>
  "config:reloaded": Record<string, never>
  "skills:changed": Record<string, never>
  "cron:reloaded": Record<string, never>
  "cron:run-finished": { jobId: string; status: "success" | "error" }
  "engines:updated": Record<string, never>
  "stt:download:progress": { progress: number }
  "stt:download:complete": { model: string }
  "stt:download:error": { error: string }
  "talk:audio": { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
  "talk:tts:download:progress": { progress: number }
  "talk:tts:download:complete": Record<string, never>
  "talk:tts:download:error": { error: string }
}

export type GatewayEventName = keyof GatewayEventMap
export type GatewayEvent = {
  [K in GatewayEventName]: { event: K; payload: GatewayEventMap[K] }
}[GatewayEventName]
export type GatewayEventListener = (frame: GatewayEvent) => void
export type GatewayEmit = <K extends GatewayEventName>(event: K, payload: GatewayEventMap[K]) => void

export const GATEWAY_EVENTS = {
  sessionStarted: "session:started",
  sessionCreated: "session:created",
  sessionUpdated: "session:updated",
  sessionDeleted: "session:deleted",
  sessionStopped: "session:stopped",
  sessionExternalTurn: "session:external-turn",
  sessionInterrupted: "session:interrupted",
  sessionCompleted: "session:completed",
  sessionDelta: "session:delta",
  sessionNotification: "session:notification",
  sessionAttachment: "session:attachment",
  sessionBackground: "session:background",
  queueUpdated: "queue:updated",
  companyChanged: "company:changed",
  pinsChanged: "pins:changed",
  notesChanged: "notes:changed",
  experimentsChanged: "experiments:changed",
  orgChanged: "org:changed",
  configReloaded: "config:reloaded",
  skillsChanged: "skills:changed",
  cronReloaded: "cron:reloaded",
  cronRunFinished: "cron:run-finished",
  enginesUpdated: "engines:updated",
  sttDownloadProgress: "stt:download:progress",
  sttDownloadComplete: "stt:download:complete",
  sttDownloadError: "stt:download:error",
  talkAudio: "talk:audio",
  talkTtsDownloadProgress: "talk:tts:download:progress",
  talkTtsDownloadComplete: "talk:tts:download:complete",
  talkTtsDownloadError: "talk:tts:download:error",
} as const satisfies Record<string, GatewayEventName>

const gatewayEventNames = new Set<string>(Object.values(GATEWAY_EVENTS))

export function isGatewayEventName(value: unknown): value is GatewayEventName {
  return typeof value === "string" && gatewayEventNames.has(value)
}

type WireRecord = Record<string, unknown>

const deltaTypes = new Set<GatewayEventMap["session:delta"]["type"]>([
  "text",
  "text_snapshot",
  "tool_use",
  "tool_result",
  "status",
  "error",
  "context",
  "block",
])

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value)
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (isNumber(value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isOptionalJsonObject(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isJsonValue(value))
}

function isDeltaType(value: unknown): value is GatewayEventMap["session:delta"]["type"] {
  return isString(value) && deltaTypes.has(value as GatewayEventMap["session:delta"]["type"])
}

function isSessionIdPayload(value: unknown): value is { sessionId: string } {
  return isRecord(value) && isString(value.sessionId)
}

function isMessageMedia(value: unknown): value is MessageMediaWire {
  return isRecord(value)
    && (value.type === "image" || value.type === "audio" || value.type === "video" || value.type === "file")
    && isString(value.url)
    && isOptionalString(value.name)
    && isOptionalString(value.mimeType)
    && isOptionalNumber(value.size)
}

function isTodoChange(value: WireRecord): boolean {
  return isString(value.action)
    && isString(value.id)
    && isOptionalString(value.sessionId)
    && isNumber(value.version)
    && isOptionalJsonObject(value.value)
}

function isCompanyChangedEvent(value: unknown): value is CompanyChangedEvent {
  if (!isRecord(value)) return false
  switch (value.entity) {
    case "todo":
      return isTodoChange(value)
    case "workflow-definition":
      return isString(value.id) && isNumber(value.revision)
    case "workflow-run":
      return isString(value.workflowId) && isString(value.runId)
    default:
      return false
  }
}

function isSessionCompleted(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isNullableString(value.result)
    && isNullableString(value.error)
    && isOptionalString(value.employee)
    && (value.title === undefined || isNullableString(value.title))
    && isOptionalNumber(value.cost)
    && isOptionalNumber(value.durationMs)
}

function isSessionDelta(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isDeltaType(value.type)
    && isString(value.content)
    && isOptionalString(value.toolName)
    && isOptionalString(value.toolId)
    && isOptionalString(value.activityReceiptId)
    && isOptionalString(value.input)
    && (value.block === undefined || isJsonValue(value.block))
}

function isSessionAttachment(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isString(value.id)
    && isString(value.content)
    && Array.isArray(value.media)
    && value.media.every(isMessageMedia)
    && isNumber(value.timestamp)
}

function isSessionBackground(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.sessionId) || !isString(value.transportState)) return false
  if (value.backgroundActivity === null) return true
  return isRecord(value.backgroundActivity)
    && isNumber(value.backgroundActivity.activeStreams)
    && isOptionalNumber(value.backgroundActivity.activeAgents)
    && isOptionalNumber(value.backgroundActivity.activeMonitors)
    && isString(value.backgroundActivity.lastActivityAt)
}

function isProgressPayload(value: unknown): boolean {
  return isRecord(value) && isNumber(value.progress)
}

function isErrorPayload(value: unknown): boolean {
  return isRecord(value) && isString(value.error)
}

type PayloadGuard = (value: unknown) => boolean

/**
 * One guard per event, keyed by name. `Record<GatewayEventName, …>` is what
 * keeps the set exhaustive: adding an event to `GatewayEventMap` without a
 * guard for it fails to compile.
 */
const payloadGuards: Record<GatewayEventName, PayloadGuard> = {
  "session:started": isSessionIdPayload,
  "session:created": isSessionIdPayload,
  "session:updated": (value) => isRecord(value) && isString(value.sessionId) && isOptionalString(value.title),
  "session:deleted": isSessionIdPayload,
  "session:stopped": isSessionIdPayload,
  "session:external-turn": isSessionIdPayload,
  "session:interrupted": (value) => isRecord(value) && isString(value.sessionId) && isString(value.reason),
  "session:completed": isSessionCompleted,
  "session:delta": isSessionDelta,
  "session:notification": (value) =>
    isRecord(value) && isString(value.sessionId) && isString(value.message) && isOptionalJsonObject(value.meta),
  "session:attachment": isSessionAttachment,
  "session:background": isSessionBackground,
  "queue:updated": (value) =>
    isRecord(value)
      && isString(value.sessionId)
      && isString(value.sessionKey)
      && isOptionalNumber(value.depth)
      && isOptionalBoolean(value.paused),
  "company:changed": isCompanyChangedEvent,
  "pins:changed": isEmptyPayload,
  "notes:changed": (value) =>
    isRecord(value)
      && isString(value.path)
      && isString(value.revision)
      && (value.action === "created" || value.action === "updated"),
  "experiments:changed": (value) =>
    isRecord(value)
      && isString(value.id)
      && (value.action === "created"
        || value.action === "updated"
        || value.action === "reading-recorded"
        || value.action === "concluded"),
  "org:changed": isEmptyPayload,
  "config:reloaded": isEmptyPayload,
  "skills:changed": isEmptyPayload,
  "cron:reloaded": isEmptyPayload,
  "cron:run-finished": (value) =>
    isRecord(value) && isString(value.jobId) && (value.status === "success" || value.status === "error"),
  "engines:updated": isEmptyPayload,
  "stt:download:progress": isProgressPayload,
  "stt:download:complete": (value) => isRecord(value) && isString(value.model),
  "stt:download:error": isErrorPayload,
  "talk:audio": (value) =>
    isRecord(value)
      && isString(value.sessionId)
      && isNumber(value.seq)
      && isString(value.mime)
      && isString(value.dataBase64)
      && isOptionalBoolean(value.last),
  "talk:tts:download:progress": isProgressPayload,
  "talk:tts:download:complete": isEmptyPayload,
  "talk:tts:download:error": isErrorPayload,
}

/** Decode an untrusted websocket frame into the shared discriminated union. */
export function decodeGatewayEvent(value: unknown): GatewayEvent | null {
  if (!isRecord(value) || !isGatewayEventName(value.event)) return null
  if (!payloadGuards[value.event](value.payload)) return null
  return value as GatewayEvent
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return decodeGatewayEvent(value) !== null
}
