import { useCallback, useEffect, useState } from 'react'
import type { Message } from '@/lib/conversations'

/**
 * Which ChatPane instance the chat route is showing, plus the optimistic user
 * message that has to survive the first send.
 *
 * The pane is keyed so that selecting a *different* session tears the old one
 * down — keep-alive panes stacked their WebSocket subscriptions and raced each
 * other. A composer that creates a session is not a different conversation
 * though: it is the same one acquiring an id, and remounting there threw the
 * transcript away mid-send. So a pane adopts the id its own first send produced
 * and keeps the key it already had.
 *
 * Both the key and the handoff key off the ADOPTED session rather than the URL,
 * because the URL lands a frame late: react-router wraps navigation in a
 * transition, so urgent state commits first and `selectedId` is briefly stale.
 * A handoff cleared on "selectedId isn't mine yet" wipes itself during the very
 * send it exists for.
 */
export interface PaneIdentity {
  /** React key for the pane. Changes only when the pane should be replaced. */
  paneKey: string
  /** Optimistic bubble to seed the pane with, when it belongs to this selection. */
  pendingMessage: Message | undefined
  /** The pane created this session — keep it mounted under its current key. */
  adoptSession: (sessionId: string, pending?: Message) => void
  /** The user asked for a blank composer — give them a fresh pane. */
  startComposer: () => void
}

export function usePaneIdentity(selectedId: string | null, pendingEmployee: string | null): PaneIdentity {
  const [adopted, setAdopted] = useState<{ sessionId: string; pending?: Message } | null>(null)
  // A composer key cannot name a session, so it counts instead. Without the
  // count, "+ New" from a just-created session would resolve to the key that
  // pane is already mounted under and silently reuse its state.
  const [composerCount, setComposerCount] = useState(0)
  const startComposer = useCallback(() => {
    setAdopted(null)
    setComposerCount((count) => count + 1)
  }, [])
  const adoptSession = useCallback((sessionId: string, pending?: Message) => {
    setAdopted({ sessionId, pending })
  }, [])
  // Let the adoption go once the user genuinely selects another session: that is
  // a different pane, and a stale bubble would re-seed if they navigated back.
  useEffect(() => {
    setAdopted((current) => (current && selectedId && selectedId !== current.sessionId ? null : current))
  }, [selectedId])
  const paneKey = selectedId && selectedId !== adopted?.sessionId
    ? selectedId
    : `__new__:${composerCount}:${pendingEmployee ?? ''}`
  return {
    paneKey,
    pendingMessage: adopted?.sessionId === selectedId ? adopted?.pending : undefined,
    adoptSession,
    startComposer,
  }
}
