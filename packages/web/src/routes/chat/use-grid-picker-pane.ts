import { useCallback, useRef, useState } from 'react'
import type { Message } from '@/lib/conversations'

type PickSession = (sessionId: string) => void
type CreatedSession = (sessionId: string, pending?: Message) => void

export function useGridPickerPane() {
  const sequence = useRef(0)
  const [paneKey, setPaneKey] = useState<string | null>(null)
  const open = useCallback(() => {
    setPaneKey((current) => current ?? `__picker__:${++sequence.current}`)
  }, [])
  const close = useCallback(() => setPaneKey(null), [])
  const bind = useCallback((onPick: PickSession, onAdd: PickSession, onSessionCreated: CreatedSession) => (
    paneKey ? {
      paneKey,
      onPick: (sessionId: string) => {
        close()
        onPick(sessionId)
      },
      onSessionCreated: (sessionId: string, pending?: Message) => {
        onAdd(sessionId)
        close()
        onSessionCreated(sessionId, pending)
      },
      onClose: close,
    } : undefined
  ), [close, paneKey])
  return { paneKey, open, close, bind }
}
