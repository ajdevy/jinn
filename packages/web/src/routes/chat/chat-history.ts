import type { CommsPeekData } from '@/components/chat/thread-peek'

export function parseHistoryPreview(value: unknown): CommsPeekData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = (value as { threadPreview?: unknown }).threadPreview
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const peek = candidate as Partial<CommsPeekData>
  const stringFields = [peek.kind, peek.employee, peek.displayName, peek.messageId, peek.preview]
  if (stringFields.some((field) => typeof field !== 'string') || typeof peek.timestamp !== 'number') return null
  return peek as CommsPeekData
}

export function historyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
