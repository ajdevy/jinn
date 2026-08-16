import { useEffect, useState } from 'react'
import { prefetchLiveSessionSnapshot, readPrefetchedLiveSessionSnapshot } from '@/hooks/use-live-session'

export interface CommittedSelection {
  /** The session the ChatPane is mounted for. */
  committedId: string | null
  /** No pane may mount yet — a bare `/` has not decided which chat it opens. */
  awaitingOpen: boolean
}

/**
 * True while a bare `/` has not yet decided which chat it opens.
 *
 * Mirrors the guard in the page's `handleSessionsLoaded`: the most recent
 * session is auto-selected as soon as the list resolves, and react-router lands
 * that URL a frame late, so "sessions exist but nothing is selected" is still
 * an inbound selection rather than a request for the composer.
 */
export function isOpenSelectionInbound(state: {
  selectedId: string | null
  newChatIntent: boolean
  sessionsPending: boolean
  sessionCount: number
}): boolean {
  return !state.selectedId
    && !state.newChatIntent
    && (state.sessionsPending || state.sessionCount > 0)
}

/**
 * The selection the PANE shows, which deliberately lags the URL.
 *
 * Two lags, one rule: never commit a pane that will immediately be replaced, or
 * that can only paint a spinner.
 *
 * - A bare `/` auto-selects the most recent session once the list resolves.
 *   Committing before that decision mounts the new-chat composer and then tears
 *   it straight back down — the flash the reader sees before the spinner.
 *   `awaitingOpen` withholds the mount until the selection is real.
 * - Switching to a session with no cached transcript mounts cold, which throws
 *   the reader's transcript away and blanks to a spinner. Warming the same
 *   snapshot cache the destination pane reads at mount lets it paint on its
 *   first commit, so the outgoing transcript is held instead of discarded. The
 *   hold runs until the destination can paint, with no deadline behind it: a
 *   timer that gives up mid-fetch commits a pane that has nothing but a spinner
 *   to show, which is the blank-then-spinner this lag exists to prevent.
 *
 * Nothing lags out of a composer: the pane that just created a session adopts
 * that id in the same commit, and delaying it would strand the send.
 */
export function useCommittedSelection(
  selectedId: string | null,
  awaitingSelection: boolean,
): CommittedSelection {
  // `null` means nothing has been committed yet, which is distinct from having
  // committed the composer (`{ id: null }`).
  const [commit, setCommit] = useState<{ id: string | null } | null>(
    () => (awaitingSelection ? null : { id: selectedId }),
  )

  useEffect(() => {
    if (awaitingSelection) return
    if (commit && commit.id === selectedId) return
    // Only a move between two sessions has a transcript worth holding: an
    // uncommitted pane has nothing on screen, and a composer has nothing to lose.
    if (!commit || commit.id === null || selectedId === null || readPrefetchedLiveSessionSnapshot(selectedId)) {
      setCommit({ id: selectedId })
      return
    }
    let cancelled = false
    const commitTarget = () => {
      if (!cancelled) setCommit({ id: selectedId })
    }
    const controller = new AbortController()
    // A failed warm still commits: the destination then takes the ordinary cold
    // path and reports the error itself, rather than stranding the reader on a
    // chat they navigated away from. Only an abort is silent, and an abort means
    // the selection moved on and a later effect owns the commit.
    void prefetchLiveSessionSnapshot(selectedId, controller.signal).then(commitTarget, commitTarget)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedId, awaitingSelection, commit])

  return { committedId: commit?.id ?? null, awaitingOpen: !commit }
}
