import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { copyText } from '@/platform'

export function useCopyFeedback() {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [copiedPaneId, setCopiedPaneId] = useState<string | null>(null)
  const sequenceRef = useRef(0)

  const showFeedback = useCallback((field: string, paneId: string | null) => {
    const sequence = ++sequenceRef.current
    setCopiedField(field)
    setCopiedPaneId(paneId)
    setTimeout(() => {
      if (sequenceRef.current !== sequence) return
      setCopiedField(null)
      setCopiedPaneId(null)
    }, 1500)
  }, [])

  const copyToClipboard = useCallback((text: string, field: string, paneId: string | null = null) => {
    // Platform-aware copy (the shell has no navigator.clipboard); feedback
    // follows the write, and is anchored to the pane that fired it.
    void copyText(text).then((result) => { if (result.status === 'performed') showFeedback(field, paneId) })
  }, [showFeedback])

  const copyChat = useCallback(async (sessionId: string) => {
    try {
      const session = await api.getSession(sessionId) as { messages?: Array<{ role: string; content: string }> }
      const text = (session.messages ?? [])
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => `[${message.role}]: ${message.content}`)
        .join('\n\n')
      if ((await copyText(text)).status !== 'performed') return
      showFeedback('chat', sessionId)
    } catch { /* Copy feedback appears only after both reads succeed. */ }
  }, [showFeedback])

  return { copiedField, copiedPaneId, copyToClipboard, copyChat }
}
