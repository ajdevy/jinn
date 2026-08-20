import {
  readPrefetchedLiveSessionSnapshot,
  type LiveSessionSnapshot,
} from "@/hooks/use-live-session"
import { queryClient } from "@/lib/query-client"
import type { Message } from "@/lib/conversations"
import type { SemanticObject } from "./screen-context-types"
import { safeSpokenText } from "./spoken-text"

const TEXT_CHARS = 240
const TAIL_LENGTH = 4
type Recency = "this turn" | "just now" | "earlier"

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const safeText = (value: unknown): string => safeSpokenText(value, TEXT_CHARS)

function lastUserTimestamp(messages: Message[]): number {
  return messages.reduce((latest, message) => (
    message.role === "user" ? Math.max(latest, message.timestamp) : latest
  ), Number.NEGATIVE_INFINITY)
}

function relativeTime(timestamp: number, capturedAt: string, lastUserAt: number): Recency {
  if (Number.isFinite(lastUserAt) && timestamp >= lastUserAt) return "this turn"
  const captured = Date.parse(capturedAt)
  const age = captured - timestamp
  return Number.isFinite(captured) && age >= 0 && age <= 60_000 ? "just now" : "earlier"
}

function stableMessage(message: Message): boolean {
  return (message.role === "user" || message.role === "assistant") && message.partial !== true
}

function recentMessage(message: Message, capturedAt: string, lastUserAt: number, order: number) {
  return {
    role: message.role,
    text: safeText(message.content),
    recency: relativeTime(message.timestamp, capturedAt, lastUserAt),
    order,
  }
}

function stableBlocks(messages: Message[], capturedAt: string, lastUserAt: number) {
  return messages.flatMap((message, messageIndex) => message.partial === true ? [] : (message.blocks ?? []).map((block, blockIndex) => ({
    type: block.type,
    title: safeText(block.title),
    status: safeText(block.status),
    summary: safeText(block.summary),
    recency: relativeTime(message.timestamp, capturedAt, lastUserAt),
    order: messageIndex * 1_000 + blockIndex,
  }))).slice(-TAIL_LENGTH)
}

function recentMessages(messages: Message[], capturedAt: string, lastUserAt: number) {
  return messages
    .map((message, index) => stableMessage(message) ? recentMessage(message, capturedAt, lastUserAt, index * 1_000 + 999) : null)
    .filter((message): message is NonNullable<typeof message> => message !== null)
    .filter((message) => message.text)
    .slice(-TAIL_LENGTH)
}

function chatActivity(live: LiveSessionSnapshot | null, source: Record<string, unknown>): string {
  const active = Boolean(
    live?.streamingText || live?.loading || live?.turnPending || source.status === "running",
  )
  return active ? "still writing" : "idle"
}

function chatTitle(source: Record<string, unknown>, employee: string): string {
  return safeText(source.title) || employee || "Current chat"
}

function cachedSession(id: string): Record<string, unknown> | null {
  const value = record(queryClient.getQueryData(["sessions", id]))
  return record(value?.session) ?? value
}

/** Shape browser-live chat state into the bounded, identifier-free packet Talk speaks. */
export function liveChatObject(id: string, capturedAt: string): SemanticObject | null {
  const live = readPrefetchedLiveSessionSnapshot(id)
  const source = live?.session ?? cachedSession(id)
  if (!source) return null
  const employee = safeText(source.employee)
  const messages = live?.messages ?? []
  const lastUserAt = lastUserTimestamp(messages)
  return {
    kind: "chat session",
    id,
    title: chatTitle(source, employee),
    status: safeText(source.status) || undefined,
    fields: {
      participants: ["operator", employee || "assistant"],
      activity: chatActivity(live, source),
      recentBlocks: recentMessages(messages, capturedAt, lastUserAt),
      stableBlocks: stableBlocks(messages, capturedAt, lastUserAt),
    },
    relations: [],
    retrievalAnchor: { kind: "session", id },
  }
}
