import type { Message } from '@/lib/conversations'

/* When a transcript shows a timestamp, and how that timestamp reads. */

export function validTimestamp(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

export function formatTimestamp(ts: number): string {
  if (validTimestamp(ts) === null) return ''
  const now = new Date()
  const date = new Date(ts)
  const isToday = now.toDateString() === date.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

export function shouldShowTimestamp(messages: Message[], index: number): boolean {
  if (validTimestamp(messages[index]?.timestamp) === null) return false
  if (index === 0) return true
  if (validTimestamp(messages[index - 1]?.timestamp) === null) return false
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}

export function TimestampDivider({ label }: { label: string }) {
  return (
    <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
      {label}
    </div>
  )
}
