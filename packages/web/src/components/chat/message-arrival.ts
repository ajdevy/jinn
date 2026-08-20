import { useEffect, useMemo, useRef } from 'react'
import type { Message } from '@/lib/conversations'
import type { MessageItem } from './chat-messages'
import { parseAgentRelay } from './agent-relay'
import { parseTeammateReply } from './teammate-reply'

/** How long an enter mark survives a live arrival. Long enough for the slowest
 *  enter (260ms) plus a paint, short enough that a windowed row the reader
 *  scrolls back to — which remounts — never replays an animation it already
 *  played. Nothing re-renders when it expires; the mark only has to be gone by
 *  the time the row is built again. */
const ENTER_MARK_TTL_MS = 1_000

/** How many unseen rows one commit may animate. Three slots, matching the cap
 *  live block arrivals already hold themselves to (`Math.min(2, batch.count) * 60`
 *  in hooks/use-live-session.ts). A commit carrying more than this is a catch-up,
 *  not an arrival — the reader was away while the chat ran on — so its older rows
 *  land as history, already in place, and only this many of the newest still play
 *  an entrance, rather than every row playing at once or the stagger tailing off
 *  for seconds. */
const LIVE_ARRIVAL_BATCH_MAX = 3

/** Stagger for a comms row's entrance. Clamped to the batch cap because an
 *  uncapped index turns a large delivery into a multi-second tail. */
export function commsArrivalDelayMs(arrival: number): number {
  return Math.min(arrival, LIVE_ARRIVAL_BATCH_MAX - 1) * 90
}

/** The CSS already flattens the enter animation, but the stagger delay is ours
 *  and would otherwise still run, holding rows back invisibly. Read live, like
 *  fold-region does — a batch is judged in the commit it arrives in. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Which rows stagger: the parsed comms kinds, and tool calls. Tool calls share
 *  the comms rail rather than getting one of their own — a tool landing next to
 *  a callback is one burst to the reader, and two rails would let the two halves
 *  of it drift apart. */
function staggersOnArrival(message: Message): boolean {
  if (message.toolCall) return true
  return message.role === 'notification' && Boolean(parseTeammateReply(message) || parseAgentRelay(message))
}

/** The rows of this commit that have never been seen, marked seen on the way
 *  out: they are history from here on whether or not the batch plays. */
function takeUnseen(messages: Message[], seen: Set<string>): [string, Message][] {
  const batch: [string, Message][] = []
  for (const message of messages) {
    const id = message.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    batch.push([id, message])
  }
  return batch
}

/**
 * Every message the grouping actually puts on screen. Grouping drops several
 * on the way — a delegation's own tool call, a dispatch superseded by its
 * block, a tool call a receipt supersedes — and those have no row to animate.
 */
export function renderedMessageIds(items: MessageItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    const rows = item.kind === 'tool-group' || item.kind === 'todo-burst'
      ? item.msgs
      : item.kind === 'callback-burst'
        ? item.entries.map((entry) => entry.msg)
        : [item.msg]
    for (const row of rows) if (row.id) ids.add(row.id)
  }
  return ids
}

/**
 * The rows of one commit that still play an entrance: the newest few, and none
 * at all under reduced motion. A catch-up reconciles on its tail because the
 * rows above it are already scrolled past by the time the transcript settles,
 * so animating them would be work the reader never sees.
 *
 * Rows that render nothing are out of the running before the cap counts: a
 * commit whose tail is a delegation's own tool call would otherwise spend every
 * slot on invisible rows and leave the chip beside them to appear instantly.
 */
function animatedRows(batch: [string, Message][], rendered: Set<string>): Set<string> {
  if (prefersReducedMotion()) return new Set()
  const visible = batch.filter(([id]) => rendered.has(id))
  return new Set(visible.slice(-LIVE_ARRIVAL_BATCH_MAX).map(([id]) => id))
}

/**
 * True for the prose row that ends a stream: its text is already on screen, and
 * re-fading a sentence the reader is in the middle of is the worst outcome
 * available here. Tool rows are excluded — they carry no transcript, so letting
 * one consume the stream would hand the animation to the wrong row.
 */
function endsAStream(message: Message, streamed: boolean): boolean {
  return streamed && message.role === 'assistant' && !message.toolCall
}

export interface MessageArrivals {
  /** Stagger index for a row on the shared arrival rail, or null when it plays
   *  no entrance. Named for the comms rows that first used it; tool calls
   *  stagger on the same rail — see `staggersOnArrival`. */
  commsArrival: (id: string | undefined) => number | null
  /** The same indices as a map, for the burst rail's own per-entry lookup. */
  commsArrivals: Map<string, number>
  /** True while a row that arrived live still owes its enter animation. */
  isEntering: (id: string | undefined) => boolean
}

/**
 * Live-arrival bookkeeping for the transcript.
 *
 * Ids present at mount never animate, which is what stops a session switch from
 * replaying a whole history's worth of enters. Nor does any commit at all under
 * reduced motion, and nor does anything but the newest LIVE_ARRIVAL_BATCH_MAX
 * rows of a commit, so a catch-up settles on a bounded tail instead of playing
 * twenty enters at once. What survives that is a live burst, and the staggering
 * rows inside one additionally carry an index for `commsArrivalDelayMs`.
 *
 * The refs are mutated inside a memo on purpose — the assignments must be
 * visible to the SAME render that first sees the message, or the row paints once
 * without its attribute and the animation is lost.
 */
export function useMessageArrivals(messages: Message[], streamingText: string, items: MessageItem[]): MessageArrivals {
  const seenIdsRef = useRef<Set<string> | null>(null)
  const commsRef = useRef<Map<string, number>>(new Map())
  const enteringRef = useRef<Set<string>>(new Set())
  // Latched rather than sampled: the commit that swaps the streaming bubble for
  // the final row is the same one that empties `streamingText`, so by the time the
  // memo below judges that row the stream has already read back empty.
  const streamedRef = useRef(false)
  if (streamingText.length > 0) streamedRef.current = true

  const rendered = useMemo(() => renderedMessageIds(items), [items])
  useMemo(() => {
    const seen = seenIdsRef.current
    if (!seen) return
    const batch = takeUnseen(messages, seen)
    const animated = animatedRows(batch, rendered)
    let batchIndex = 0
    for (const [id, message] of batch) {
      // The row that ends a stream plays nothing, and consumes the stream that
      // produced it so the next arrival is judged on its own. The latch has to be
      // spent even in a batch that plays nothing, or it silences a later arrival.
      if (endsAStream(message, streamedRef.current)) {
        streamedRef.current = false
        continue
      }
      if (!animated.has(id)) continue
      enteringRef.current.add(id)
      setTimeout(() => enteringRef.current.delete(id), ENTER_MARK_TTL_MS)
      if (staggersOnArrival(message)) commsRef.current.set(id, batchIndex++)
    }
  }, [messages])

  // A stop or an interruption empties the stream without ever committing a final
  // row, and a latch left standing would silence the next assistant arrival. Once
  // this render has had its chance to hand the stream to a row, an empty stream
  // owns nothing: whatever arrives next is a fresh row and earns its entrance.
  if (streamingText.length === 0) streamedRef.current = false

  useEffect(() => {
    if (!seenIdsRef.current) {
      seenIdsRef.current = new Set(messages.map((message) => message.id).filter(Boolean) as string[])
    }
  }, [messages])

  return {
    commsArrivals: commsRef.current,
    commsArrival: (id) => (id != null ? commsRef.current.get(id) ?? null : null),
    isEntering: (id) => id != null && enteringRef.current.has(id),
  }
}
