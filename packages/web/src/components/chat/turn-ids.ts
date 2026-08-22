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
 * The turns whose stream stopped mid-row. What severs a turn is not that it holds
 * a half-written row but WHERE that row sits: one surviving past the answer that
 * closes its segment means the stream never got back — the last whole row above it
 * is still interim prose. A partial row before that answer is spent evidence, and
 * the turn it belongs to closed normally.
 *
 * `finalAnswers` is `finalAnswerIndices`' output, passed in from the caller that
 * already holds it; -1 there means the segment elected no answer at all.
 */
export function openTurnIds(messages: Message[], turnIds: string[], finalAnswers: number[]): Set<string> {
  return new Set(turnIds.filter((_, i) => messages[i].partial && i > finalAnswers[i]))
}
