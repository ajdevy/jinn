/**
 * The chat route's pane slot, with everything around it stripped away, plus the
 * frame recorder the open-continuity suite counts off.
 *
 * The wiring is real — usePaneIdentity, which owns the commit lag, plus
 * useLiveSession and useHydrationSpinner — with only the transport faked by the
 * importing suite. The spinner predicate is copied from chat-pane.tsx (search
 * `showSessionHydration`): the one line this harness restates, and it has to
 * stay in step.
 */
import { useEffect } from 'react'
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { usePaneIdentity } from '../pane-identity'
import { useHydrationSpinner, useRouteLoadingPresence } from '@/components/chat/chat-hydration'
import { useLiveSession } from '@/hooks/use-live-session'
import type { GatewayEventListener } from '@jinn/gateway-events'

/** One committed paint of the pane. A frame only exists when something is
 *  mounted, so an absent frame IS the withheld mount. */
export interface Frame {
  sessionId: string | null
  content: boolean
  spinner: boolean
}

export const SPINNER_THRESHOLD_MS = 250
/** Slower than the spinner threshold: a cold open genuinely shows its spinner. */
export const SLOW_MS = 400
/** Quick enough that a switch warms its destination in a beat. */
export const FAST_MS = 100
/** Long enough that a stalled destination would have shown a spinner by now. */
export const PAST_ANY_THRESHOLD_MS = 1_000

export const frames: Frame[] = []

export function resetFrames() {
  frames.length = 0
}

function subscribe(_listener: GatewayEventListener) {
  return () => {}
}

export function transcript(id: string, rows: number) {
  return Array.from({ length: rows }, (_, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${id} row ${i}`,
    timestamp: 1_000 + i,
  }))
}

function Pane({ sessionId }: { sessionId: string | null }) {
  const { messages, hydrating, streamingText } = useLiveSession(sessionId, { subscribe })
  const spinner = useHydrationSpinner(Boolean(sessionId && hydrating && messages.length === 0 && !streamingText))
  useEffect(() => {
    frames.push({ sessionId, content: messages.length > 0, spinner })
  })
  return null
}

interface SurfaceProps {
  selectedId: string | null
  sessionsPending?: boolean
  sessionCount?: number
  newChatIntent?: boolean
}

export function Surface({ selectedId, sessionsPending = false, sessionCount = 0, newChatIntent = false }: SurfaceProps) {
  const { paneKey, committedId, awaitingOpen } = usePaneIdentity(selectedId, null, {
    newChatIntent,
    sessionsPending,
    sessionCount,
  })
  if (awaitingOpen) return null
  return <Pane key={paneKey} sessionId={committedId} />
}

/** The route-level fallback a cold direct open waits at before the chat chunk
 *  lands. It records frames too, so a handoff to the pane is counted as part of
 *  the same open rather than as something that happened before it. */
function RouteFallback() {
  useRouteLoadingPresence()
  useEffect(() => {
    frames.push({ sessionId: null, content: false, spinner: true })
  })
  return null
}

/** A cold direct open: the route fallback until the chat chunk resolves, then
 *  the pane, exactly as the Suspense boundary in main.tsx swaps them. */
export function ColdDirectOpen({ selectedId, chunkLoaded }: { selectedId: string; chunkLoaded: boolean }) {
  return chunkLoaded ? <Surface selectedId={selectedId} sessionCount={3} /> : <RouteFallback />
}

/** Number of times a spinner appeared — a run of spinner frames counts once. */
export function loadingStates(recorded: Frame[]): number {
  let count = 0
  recorded.forEach((frame, i) => {
    if (frame.spinner && !recorded[i - 1]?.spinner) count += 1
  })
  return count
}

/** The defect this ticket exists for: content on screen, then a spinner over it. */
export function spinnerAfterContent(recorded: Frame[]): boolean {
  const firstContent = recorded.findIndex((frame) => frame.content)
  return firstContent >= 0 && recorded.slice(firstContent).some((frame) => frame.spinner)
}

/** One jump of the fake clock coalesces every state update it triggers into a
 *  single React commit, which would hide the very frames this suite counts.
 *  Stepping in slices lets React commit between timers, the way real frames do. */
export async function advance(ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, remaining)) })
  }
}
