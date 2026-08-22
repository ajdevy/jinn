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
