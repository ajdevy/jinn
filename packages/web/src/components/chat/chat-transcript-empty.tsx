import type { ReactNode } from 'react'

/**
 * Sits over the transcript's scroll owner rather than replacing it, so the node
 * the first message lands in is the same node that was on screen before the
 * send. Replacing it is what made the first message blank the chat.
 */
export function TranscriptEmptyState({ children }: { children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {children ?? (
        <div className="text-center">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">Start a conversation</div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">Send a message or use /new to begin</div>
        </div>
      )}
    </div>
  )
}
