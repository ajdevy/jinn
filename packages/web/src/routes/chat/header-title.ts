import type { SessionMeta } from './use-chat-pane-state'

/** A session as the list knows it — the authority the header can consult before
 *  that chat's own meta has been fetched. */
interface ListedSession {
  id?: unknown
  title?: unknown
  employee?: unknown
}

function displayable(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

/**
 * The conversation title for the chat header.
 *
 * Live meta arrives per pane and lands a fetch after a switch, so every source
 * here is keyed to the id now in front of the reader: a fallback can name the
 * focused chat or nothing, never the chat it replaced. Landing on "Untitled"
 * rather than a blank matches the sidebar and the add menu — mobile centres this
 * string unconditionally, and an empty one renders as a hole in the nav bar.
 */
export function chatHeaderTitle({
  focusedSessionId,
  meta,
  sessions,
}: {
  focusedSessionId: string | null
  meta: SessionMeta | null
  sessions: ReadonlyArray<ListedSession> | undefined
}): string {
  if (!focusedSessionId) return 'New chat'
  const live = meta?.sessionId === focusedSessionId ? meta : undefined
  const listed = sessions?.find((session) => String(session.id ?? '') === focusedSessionId)
  const candidates = [live?.title, listed?.title, live?.employee, listed?.employee]
  return candidates.map(displayable).find(Boolean) ?? 'Untitled'
}
