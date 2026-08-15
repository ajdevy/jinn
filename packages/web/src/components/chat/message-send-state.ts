import type { Message } from '@/lib/conversations'

/**
 * The send lifecycle of the reader's own message, as list transitions.
 *
 * There are three states and only two of them are stored. `pending` and
 * `failed` live on the message as `sendState`; `sent` is their absence, because
 * the resting bubble already is the "sent" signal and a second cue for the
 * default state would sit on every row in the transcript forever.
 */

/**
 * Append the optimistic user message, dropping the failed attempt it replaces.
 *
 * Retry re-sends the failed bubble's own text down the ordinary send path, which
 * mints a fresh id, so without this the failed row would sit stranded beside the
 * new pending one. Superseding it here keeps retry on one send route instead of
 * inventing a second.
 */
export function beginSendMessages(current: Message[], userMsg: Message): Message[] {
  const kept = current.filter((m) => !(m.sendState === 'failed' && m.content === userMsg.content))
  return [...kept, { ...userMsg, sendState: 'pending' as const }]
}

/**
 * Move the failure onto the message that failed.
 *
 * `reason` is the transport error. It is not rendered as copy — the row reads
 * `Not delivered · Retry` — but it is carried rather than discarded so the
 * bubble can surface what actually went wrong on hover.
 */
export function markSendFailed(current: Message[], failedId: string | undefined, reason: string): Message[] {
  if (!failedId) return current
  return current.map((m) => (m.id === failedId ? { ...m, sendState: 'failed' as const, sendError: reason } : m))
}

/**
 * Clear the pending flag: the server has acknowledged the send.
 *
 * Returns the identical array when nothing is pending, so the per-frame call
 * this sits behind cannot re-render the transcript on every streamed token.
 */
export function clearPendingSend(current: Message[]): Message[] {
  const index = current.findIndex((m) => m.sendState === 'pending')
  if (index === -1) return current
  const next = current.slice()
  next[index] = { ...next[index], sendState: undefined }
  return next
}
