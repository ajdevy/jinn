import type { Message } from '@/lib/conversations'

/**
 * The user message that owns each row, by raw index — the id a pending-turn
 * gate is keyed on. Rows before the first ask belong to `head`.
 */
export function turnIdByIndex(messages: Message[]): string[] {
  let turnId = 'head'
  return messages.map((msg, i) => {
    if (msg.role === 'user') turnId = msg.id || `t${i}`
    return turnId
  })
}

/**
 * The turns that still hold a half-written row. A turn whose stream stopped
 * mid-row never produced its answer — the last whole row it managed is still
 * interim prose, whether the stream is live or was interrupted.
 */
export function openTurnIds(messages: Message[], turnIds: string[]): Set<string> {
  return new Set(turnIds.filter((_, i) => messages[i].partial))
}
