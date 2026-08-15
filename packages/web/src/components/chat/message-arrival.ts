import { useEffect, useMemo, useRef } from 'react'
import type { Message } from '@/lib/conversations'
import { parseAgentRelay } from './agent-relay'
import { parseTeammateReply } from './teammate-reply'

/** How long an enter mark survives a live arrival. Long enough for the slowest
 *  enter (260ms) plus a paint, short enough that a windowed row the reader
 *  scrolls back to — which remounts — never replays an animation it already
 *  played. Nothing re-renders when it expires; the mark only has to be gone by
 *  the time the row is built again. */
const ENTER_MARK_TTL_MS = 1_000

/** Comms rows are the only ones that stagger, and only the parsed kinds. */
function isCommsRow(message: Message): boolean {
  return message.role === 'notification' && Boolean(parseTeammateReply(message) || parseAgentRelay(message))
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
  /** Comms stagger index for a row, or null when it did not arrive live. */
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
 * replaying a whole history's worth of enters. Comms rows additionally carry a
 * stagger index (+90ms per row within a delivery batch).
 *
 * The refs are mutated inside a memo on purpose — the assignments must be
 * visible to the SAME render that first sees the message, or the row paints once
 * without its attribute and the animation is lost.
 */
export function useMessageArrivals(messages: Message[], streamingText: string): MessageArrivals {
  const seenIdsRef = useRef<Set<string> | null>(null)
  const commsRef = useRef<Map<string, number>>(new Map())
  const enteringRef = useRef<Set<string>>(new Set())
  // Latched rather than sampled: a render can land between the last token and
  // the commit that swaps the streaming bubble for the final row, and by then
  // `streamingText` has already read back empty.
  const streamedRef = useRef(false)
  if (streamingText.length > 0) streamedRef.current = true

  useMemo(() => {
    const seen = seenIdsRef.current
    if (!seen) return
    let batchIndex = 0
    for (const message of messages) {
      const id = message.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      // The row that ends a stream plays nothing, and consumes the stream that
      // produced it so the next arrival is judged on its own.
      if (endsAStream(message, streamedRef.current)) {
        streamedRef.current = false
      } else {
        enteringRef.current.add(id)
        setTimeout(() => enteringRef.current.delete(id), ENTER_MARK_TTL_MS)
      }
      if (isCommsRow(message)) commsRef.current.set(id, batchIndex++)
    }
  }, [messages])

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
