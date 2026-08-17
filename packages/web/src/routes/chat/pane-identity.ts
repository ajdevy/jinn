import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Message } from '@/lib/conversations'
import { isOpenSelectionInbound, useCommittedSelection } from './selection-commit'

/**
 * Which ChatPane instance the chat route is showing and when it may show it,
 * plus the optimistic user message that has to survive the first send.
 *
 * The pane runs one step behind the URL: `committedId`, not the selection the
 * URL carries, is the session it is mounted for. A bare `/` withholds the mount
 * until the auto-select lands, so the new-chat composer never paints only to be
 * replaced; a switch keeps the outgoing transcript up until the incoming one can
 * paint. `selection-commit.ts` owns that lag and explains both halves.
 *
 * The pane is keyed so that selecting a *different* session tears the old one
 * down — keep-alive panes stacked their WebSocket subscriptions and raced each
 * other. A composer that creates a session is not a different conversation
 * though: it is the same one acquiring an id, and remounting there threw the
 * transcript away mid-send. So a pane adopts the id its own first send produced
 * and keeps the key it already had.
 *
 * Both the key and the handoff key off the ADOPTED session rather than the
 * committed one, because the URL lands a frame late: react-router wraps
 * navigation in a transition, so urgent state commits first and the selection
 * is briefly stale. A handoff cleared on "that isn't mine yet" wipes itself
 * during the very send it exists for.
 */
export interface PaneIdentity {
  /** React key for the pane. Changes only when the pane should be replaced. */
  paneKey: string
  /** The session the pane is mounted for — the URL's selection, one step late. */
  committedId: string | null
  /** No pane at all yet: `/` has not decided which chat it opens. */
  awaitingOpen: boolean
  /** Optimistic bubble to seed the pane with, when it belongs to this selection. */
  pendingMessage: Message | undefined
  /** The element the pane is rendered in. A phone hides this slot behind the
   *  chat list, which is how `revealSelection` tells whether the pane the reader
   *  is leaving is on screen at all. */
  paneSlotRef: RefObject<HTMLDivElement | null>
  /** A reader-initiated open, which puts the pane slot on screen in the same
   *  paint it happens in. */
  revealSelection: (sessionId: string) => void
  /** The pane created this session — keep it mounted under its current key. */
  adoptSession: (sessionId: string, pending?: Message) => void
  /** The user asked for a blank composer — give them a fresh pane. */
  startComposer: () => void
}

/** What the route knows about a bare `/` that may still be resolving. */
export interface OpeningState {
  newChatIntent: boolean
  sessionsPending: boolean
  sessionCount: number
}

export function usePaneIdentity(
  urlSelectedId: string | null,
  pendingEmployee: string | null,
  opening: OpeningState,
): PaneIdentity {
  const { committedId, awaitingOpen, commitWithoutHold } = useCommittedSelection(
    urlSelectedId,
    isOpenSelectionInbound({ selectedId: urlSelectedId, ...opening }),
  )
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
    setAdopted((current) => (current && committedId && committedId !== current.sessionId ? null : current))
  }, [committedId])
  const paneSlotRef = useRef<HTMLDivElement | null>(null)
  const revealSelection = useCallback((sessionId: string) => {
    // A slot a phone has display-toggled away measures zero high. The pane is
    // still mounted inside it, so the hold would not keep anything the reader
    // can see: it would put the chat they just left back in front of them for
    // the length of the destination's fetch, over the tap that left it.
    if (paneSlotRef.current?.clientHeight) return
    commitWithoutHold(sessionId)
  }, [commitWithoutHold])
  const paneKey = committedId && committedId !== adopted?.sessionId
    ? committedId
    : `__new__:${composerCount}:${pendingEmployee ?? ''}`
  return {
    paneKey,
    committedId,
    awaitingOpen,
    pendingMessage: adopted?.sessionId === committedId ? adopted?.pending : undefined,
    paneSlotRef,
    revealSelection,
    adoptSession,
    startComposer,
  }
}
