/* The chat sidebar's localStorage preferences: which sessions have been read,
 * which employee groups are collapsed, and which are expanded. Storage I/O
 * only, so the sidebar itself holds the sidebar. Every read is guarded because
 * a hand-edited or half-written value must degrade to "no preference" rather
 * than take the list down with it. */

import type { Session } from "@/components/chat/session-signals"

const READ_STORAGE_KEY = "jinn-read-sessions"
const COLLAPSE_STORAGE_KEY = "jinn-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "jinn-sidebar-expanded"

// The read set is capped so a long-lived instance cannot grow one unbounded
// localStorage row; the oldest ids fall off first.
const MAX_READ_SESSIONS = 500

export function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveReadSessions(read: Set<string>) {
  const ids = Array.from(read)
  if (ids.length > MAX_READ_SESSIONS) ids.splice(0, ids.length - MAX_READ_SESSIONS)
  localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(ids))
}

export function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  saveReadSessions(read)
}

export function markAllReadForEmployee(sessions: Session[]) {
  const read = getReadSessions()
  for (const session of sessions) read.add(session.id)
  saveReadSessions(read)
}

export function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {}
}

export function loadExpandedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveExpandedState(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  } catch {}
}
