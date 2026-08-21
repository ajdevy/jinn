import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { api, type QueueItem } from '@/lib/api'

/* A session's parked messages, addressed the way the transcript addresses them.
 * The queue's own order is not the transcript's — send-now moves payloads
 * between rows without moving the bubbles — so a card carries its own position
 * rather than inferring one from where it sits in the thread. */

export interface QueuedMessage {
  item: QueueItem
  /** 1 for the message that runs next. */
  position: number
}

export interface SessionQueue {
  byMessageId: ReadonlyMap<string, QueuedMessage>
  cancel: (itemId: string) => Promise<void>
  edit: (itemId: string, prompt: string) => Promise<void>
  sendNow: (itemId: string) => Promise<void>
}

const EMPTY: SessionQueue = {
  byMessageId: new Map(),
  cancel: async () => {},
  edit: async () => {},
  sendNow: async () => {},
}

export const SessionQueueContext = createContext<SessionQueue>(EMPTY)

/** Parked rows, keyed by the bubble each one will run. Rows with no message
 *  link are real queue work with nothing to render against, so they are left out
 *  rather than guessed at. */
export function indexByMessage(items: readonly QueueItem[]): ReadonlyMap<string, QueuedMessage> {
  const parked = items.filter((item) => item.status === 'pending')
  return new Map(parked.flatMap((item, index): Array<[string, QueuedMessage]> =>
    item.messageId ? [[item.messageId, { item, position: index + 1 }]] : []))
}

export function useSessionQueue(
  sessionId: string | null,
  subscribe: (fn: GatewayEventListener) => () => void,
): SessionQueue {
  const [items, setItems] = useState<QueueItem[]>([])

  const refresh = useCallback(async () => {
    if (!sessionId) return setItems([])
    try {
      setItems(await api.getSessionQueue(sessionId))
    } catch {
      // Non-fatal: the cards keep showing what the last good read said, and the
      // next queue:updated re-reads. A failed poll must not blank the thread.
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => subscribe((frame) => {
    if (frame.event !== 'queue:updated') return
    if (frame.payload.sessionId !== sessionId) return
    void refresh()
  }), [subscribe, sessionId, refresh])

  const act = useCallback(async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch {
      // Non-fatal: the refresh below re-reads the truth either way.
    }
    await refresh()
  }, [refresh])

  const byMessageId = useMemo(() => indexByMessage(items), [items])

  return useMemo<SessionQueue>(() => sessionId === null ? EMPTY : {
    byMessageId,
    cancel: (itemId) => act(() => api.cancelQueueItem(sessionId, itemId)),
    edit: (itemId, prompt) => act(() => api.editQueueItem(sessionId, itemId, prompt)),
    sendNow: (itemId) => act(() => api.sendQueueItemNow(sessionId, itemId)),
  }, [sessionId, byMessageId, act])
}
