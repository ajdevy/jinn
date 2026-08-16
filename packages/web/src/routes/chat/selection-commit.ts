import { useEffect, useState } from 'react'
import { prefetchLiveSessionSnapshot, readPrefetchedLiveSessionSnapshot } from '@/hooks/use-live-session'

/**
 * How long a switch may keep the chat you are leaving on screen while the one
 * you asked for is fetched. Past this the pane commits cold and the 250ms
 * hydration threshold owns the rest of the wait: a transcript held against a
 * slow gateway is worse than a spinner, because it is the WRONG transcript.
 */
export const SWITCH_HOLD_MS = 250

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
 *   first commit, so the outgoing transcript is held instead of discarded.
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
    let settled = false
    const commitTarget = () => {
      if (settled) return
      settled = true
      setCommit({ id: selectedId })
    }
    const controller = new AbortController()
    const timer = window.setTimeout(commitTarget, SWITCH_HOLD_MS)
    // A failed warm still commits: the destination then takes the ordinary cold
    // path and reports the error itself, rather than stranding the reader on a
    // chat they navigated away from.
    void prefetchLiveSessionSnapshot(selectedId, controller.signal).then(commitTarget, commitTarget)
    return () => {
      settled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [selectedId, awaitingSelection, commit])

  return { committedId: commit?.id ?? null, awaitingOpen: !commit }
}
