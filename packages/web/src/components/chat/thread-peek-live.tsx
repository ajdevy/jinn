import { useEffect, useState, type ReactNode } from 'react'
import { StateLine, type StateLineState } from '@/components/ui/state-line'
import { useGateway } from '@/hooks/use-gateway'
import {
  prefetchLiveSessionSnapshot,
  readPrefetchedLiveSessionSnapshot,
  useLiveSession,
} from '@/hooks/use-live-session'
import type { Message } from '@/lib/conversations'
import { clockTime } from './comms-callout'
import { cleanLikeGateway, fullReplyCache } from './teammate-reply'
import type { CommsPeekData } from './thread-peek'

export interface PeekViewModel {
  state: StateLineState
  label?: string
  dispatchedAt?: number
  body: string
}

export function shouldLiveSubscribe(peek: CommsPeekData): boolean {
  return Boolean(peek.sessionId)
    && !peek.fullMessage
    && (peek.kind === 'delegation' || peek.kind === 'dispatch')
}

async function fetchChildPreview(
  sessionId: string,
  kind: CommsPeekData['kind'],
  preview: string,
): Promise<string | null> {
  await prefetchLiveSessionSnapshot(sessionId)
  const messages = readPrefetchedLiveSessionSnapshot(sessionId)?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue
    const content = message.content.trim()
    if (!content) continue
    if (kind === 'reply') {
      if (cleanLikeGateway(content) === preview) return content
      continue
    }
    return content
  }
  return null
}

export function usePeekBody(peek: CommsPeekData): string {
  const [fetched, setFetched] = useState<string | null>(() => fullReplyCache.get(peek.messageId) ?? null)

  useEffect(() => {
    const cached = fullReplyCache.get(peek.messageId) ?? null
    setFetched(cached)
    if (peek.fullMessage || cached) return
    if (!peek.sessionId || shouldLiveSubscribe(peek)) return
    let cancelled = false
    const request = peek.kind === 'reply' && peek.preview
      ? fetchChildPreview(peek.sessionId, peek.kind, peek.preview)
      : Promise.resolve(null)
    request
      .then((text) => {
        fullReplyCache.set(peek.messageId, text)
        if (!cancelled) setFetched(text)
      })
      .catch(() => { /* The source preview remains the honest fallback. */ })
    return () => { cancelled = true }
  }, [peek])

  return peek.fullMessage ?? fetched ?? peek.preview
}

export function finishedLabel(peek: CommsPeekData, error: boolean): string {
  if (error) return "Couldn't finish"
  if (peek.kind === 'relay') return `Messaged · ${clockTime(peek.timestamp)}`
  if (peek.kind === 'delegation') return `Delegated · ${clockTime(peek.timestamp)}`
  if (peek.kind === 'dispatch') return `Followed up · ${clockTime(peek.timestamp)}`
  return `Replied · ${clockTime(peek.timestamp)}`
}

export function PeekStateLine({ view }: { view: PeekViewModel }) {
  return (
    <StateLine
      state={view.state}
      label={view.label}
      dispatchedAt={view.dispatchedAt}
      className="mt-0.5"
    />
  )
}

function isWorkingStatus(status: unknown): boolean {
  return status === 'running' || status === 'waiting'
}

function finishedBody(peek: CommsPeekData, messages: Message[]): string {
  if (peek.fullMessage) return peek.fullMessage
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue
    const content = message.content.trim()
    if (!content) continue
    if (peek.kind === 'reply') {
      if (cleanLikeGateway(content) === peek.preview) return content
      continue
    }
    return content
  }
  return peek.preview
}

function workingActivity(messages: Message[], streamingText: string): string | null {
  let latestText = ''
  let latestTool = ''
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue
    const content = message.content.trim()
    if (!content) continue
    if (message.toolCall || content.startsWith('Using ') || content.startsWith('Used ')) {
      latestTool = content
    } else {
      latestText = content
    }
  }
  const stream = streamingText.trim()
  const parts = [latestText, latestTool, stream].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : null
}

function peekIsWorking(peek: CommsPeekData, status: unknown, hydrating: boolean): boolean {
  if (isWorkingStatus(status)) return true
  if (typeof status === 'string' && status) return false
  if (!hydrating) return false
  return peek.kind === 'delegation' || peek.kind === 'dispatch'
}

function livePeekView(
  peek: CommsPeekData,
  session: Record<string, unknown> | null,
  messages: Message[],
  streamingText: string,
  hydrating: boolean,
): PeekViewModel {
  const status = session?.status
  const error = peek.kind === 'error' || status === 'error'
  if (peekIsWorking(peek, status, hydrating)) {
    return {
      state: 'working',
      dispatchedAt: peek.timestamp,
      body: workingActivity(messages, streamingText) ?? 'Starting up',
    }
  }
  return {
    state: error ? 'error' : 'replied',
    label: finishedLabel(peek, error),
    body: finishedBody(peek, messages),
  }
}

export function PeekLiveSession({
  peek,
  renderContent,
  children,
}: {
  peek: CommsPeekData
  renderContent: (text: string) => ReactNode
  children: (view: { stateLine: ReactNode; body: ReactNode }) => ReactNode
}) {
  const { subscribe, connectionSeq } = useGateway()
  const live = useLiveSession(peek.sessionId ?? null, {
    subscribe,
    connectionSeq,
    readOnly: true,
  })
  const view = livePeekView(peek, live.session, live.messages, live.streamingText, live.hydrating)
  return children({
    stateLine: <PeekStateLine view={view} />,
    body: renderContent(view.body),
  })
}
