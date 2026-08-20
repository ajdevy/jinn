import { useEffect, useMemo, useState } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { api } from '@/lib/api'
import { cleanPreview } from '@/lib/clean-preview'

export interface MobileWorkingSetActivity {
  preview: string
  revision: number
  moved: boolean
  receivingText: boolean
}

interface ActivityFrame {
  event: string
  payload: unknown
}

const EMPTY_ACTIVITY: MobileWorkingSetActivity = {
  preview: '',
  revision: 0,
  moved: false,
  receivingText: false,
}

function framePayload(frame: ActivityFrame): Record<string, unknown> {
  return frame.payload && typeof frame.payload === 'object'
    ? frame.payload as Record<string, unknown>
    : {}
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const record = part as Record<string, unknown>
    return typeof record.text === 'string' ? record.text : ''
  }).join(' ')
}

export function mobileWorkingSetIds(
  memberIds: readonly string[],
  sessions: ReadonlyArray<{ id?: unknown }>,
): string[] {
  const ids: string[] = []
  const add = (id: string) => {
    if (id && !ids.includes(id) && ids.length < 4) ids.push(id)
  }
  memberIds.forEach(add)
  sessions.forEach((session) => add(String(session.id ?? '')))
  return ids
}

export function clearMobileWorkingSetMoved(
  state: Record<string, MobileWorkingSetActivity>,
  activeId: string | null,
): Record<string, MobileWorkingSetActivity> {
  if (!activeId || !state[activeId]?.moved) return state
  return { ...state, [activeId]: { ...state[activeId], moved: false } }
}

function reduceTextDelta(
  current: MobileWorkingSetActivity,
  moved: boolean,
  payload: Record<string, unknown>,
): MobileWorkingSetActivity | null {
  const type = payload.type
  const chunk = textContent(payload.content)
  if (!chunk || (type !== 'text' && type !== 'text_snapshot')) return null
  const startsMessage = type === 'text' && !current.receivingText
  const preview = cleanPreview(type === 'text_snapshot'
    ? chunk
    : `${startsMessage ? '' : current.preview}${chunk}`)
  return {
    preview,
    revision: current.revision + (startsMessage ? 1 : 0),
    moved: current.moved || moved,
    receivingText: true,
  }
}

function completeContent(event: string, payload: Record<string, unknown>): string {
  if (event === 'session:notification') return textContent(payload.content)
  if (event === 'session:attachment') return textContent(payload.content ?? payload.name)
  if (event === 'session:completed') return textContent(payload.result)
  return ''
}

function reduceCompleteMessage(
  current: MobileWorkingSetActivity,
  moved: boolean,
  event: string,
  payload: Record<string, unknown>,
): MobileWorkingSetActivity | null {
  const complete = cleanPreview(completeContent(event, payload))
  if (!complete) return null
  const sameStream = current.receivingText && complete === current.preview
  return {
    preview: complete,
    revision: current.revision + (sameStream ? 0 : 1),
    moved: current.moved || moved,
    receivingText: false,
  }
}

export function reduceMobileWorkingSetActivity(
  state: Record<string, MobileWorkingSetActivity>,
  memberIds: readonly string[],
  activeId: string | null,
  frame: ActivityFrame,
): Record<string, MobileWorkingSetActivity> {
  const payload = framePayload(frame)
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!sessionId || !memberIds.includes(sessionId)) return state

  const current = state[sessionId] ?? EMPTY_ACTIVITY
  const moved = sessionId !== activeId
  const next = frame.event === 'session:delta'
    ? reduceTextDelta(current, moved, payload)
    : reduceCompleteMessage(current, moved, frame.event, payload)
  return next ? { ...state, [sessionId]: next } : state
}

function lastMessagePreview(response: { messages?: unknown }): string {
  const messages = Array.isArray(response.messages) ? response.messages : []
  const last = messages.at(-1)
  if (!last || typeof last !== 'object') return ''
  return cleanPreview(textContent((last as Record<string, unknown>).content))
}

export function useMobileWorkingSetActivity({
  sessionIds,
  activeId,
  subscribe,
  connectionSeq,
}: {
  sessionIds: string[]
  activeId: string | null
  subscribe: (listener: GatewayEventListener) => () => void
  connectionSeq: number
}) {
  const [state, setState] = useState<Record<string, MobileWorkingSetActivity>>({})
  const memberKey = sessionIds.join('\u0000')

  useEffect(() => {
    let live = true
    void Promise.all(sessionIds.map(async (sessionId) => {
      const response = await api.getSessionMessages(sessionId, { limit: 1 })
      return [sessionId, lastMessagePreview(response)] as const
    })).then((entries) => {
      if (!live) return
      setState((current) => {
        const next = { ...current }
        for (const [sessionId, preview] of entries) {
          if (!preview || current[sessionId]?.receivingText) continue
          next[sessionId] = { ...(current[sessionId] ?? EMPTY_ACTIVITY), preview }
        }
        return next
      })
    }).catch(() => { /* Live frames still keep the strip current. */ })
    return () => { live = false }
  }, [connectionSeq, memberKey])

  useEffect(() => subscribe((frame) => {
    setState((current) => reduceMobileWorkingSetActivity(current, sessionIds, activeId, frame))
  }), [activeId, memberKey, sessionIds, subscribe])

  useEffect(() => {
    setState((current) => clearMobileWorkingSetMoved(current, activeId))
  }, [activeId])

  return useMemo(() => Object.fromEntries(sessionIds.map((sessionId) => [
    sessionId,
    state[sessionId] ?? EMPTY_ACTIVITY,
  ])), [memberKey, sessionIds, state])
}
