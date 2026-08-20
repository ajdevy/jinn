import type { Message } from '@/lib/conversations'

/**
 * One source of truth for the gap above a row, computed from the previous
 * message's role. The streaming container and the pre-token Thinking indicator
 * use the SAME function as the final row that replaces them, so the swap is a
 * pure text-node replacement — zero movement by construction.
 */
export function turnSpacerClass(prevRole: Message['role'], role: Message['role']): string {
  // The switch AFTER a user message gets extra headroom (24px): the accent
  // bubble's fill weight optically eats a plain 16px gap before the reply.
  if (prevRole === 'user' && role !== 'user') return 'h-[var(--space-6)]'
  if (prevRole !== role) return 'h-[var(--space-4)]'
  return 'h-[var(--space-1)]'
}
