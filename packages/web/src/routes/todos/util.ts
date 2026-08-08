import type { Employee } from "@/lib/api"

/** Compact relative time: "22m", "4h", "Yesterday", "Jul 4". Past only. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const diff = Math.max(0, now - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day === 1) return "Yesterday"
  if (day < 7) return `${day}d`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Resolve a display name for an assignee employee key, falling back to the key. */
export function displayNameOf(assignee: string | null, byName: Map<string, Employee>): string {
  if (!assignee) return ""
  return byName.get(assignee)?.displayName ?? assignee
}
