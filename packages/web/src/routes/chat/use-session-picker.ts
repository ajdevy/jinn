import { useMemo } from 'react'
import type { Session } from '@/components/chat/session-signals'
import { usePins } from '@/hooks/use-pins'
import { useSessions, useSessionSearch } from '@/hooks/use-sessions'

export type SessionPickerRow =
  | { kind: 'group'; id: string; label: string }
  | { kind: 'session'; id: string; session: Session; pinned: boolean }

const EMPTY_PINS = new Set<string>()

function activity(session: Session): string {
  return session.lastActivity || session.createdAt || ''
}

function pickerRows(source: Session[], pins: Set<string>): SessionPickerRow[] {
  const sorted = source
    .filter((session) => typeof session.id === 'string' && session.id.length > 0)
    .sort((a, b) => activity(b).localeCompare(activity(a)))
  const pinned = sorted.filter((session) => pins.has(session.id))
  const recent = sorted.filter((session) => !pins.has(session.id))
  const rows: SessionPickerRow[] = []
  if (pinned.length > 0) {
    rows.push({ kind: 'group', id: 'pinned', label: 'Pinned' })
    rows.push(...pinned.map((session) => ({ kind: 'session' as const, id: session.id, session, pinned: true })))
  }
  if (recent.length > 0) {
    rows.push({ kind: 'group', id: 'recent', label: 'Recent' })
    rows.push(...recent.map((session) => ({ kind: 'session' as const, id: session.id, session, pinned: false })))
  }
  return rows
}

export function useSessionPicker(query: string): { rows: SessionPickerRow[]; loading: boolean } {
  const { data: sessions = [], isLoading } = useSessions()
  const { data: pins = EMPTY_PINS } = usePins()
  const search = useSessionSearch(query)
  const searching = query.trim().length > 0
  const source = (searching ? search.data ?? [] : sessions) as Session[]
  const rows = useMemo(() => pickerRows(source, pins), [pins, source])
  return { rows, loading: isLoading || (searching && search.isLoading) }
}
