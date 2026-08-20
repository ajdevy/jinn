import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import { hasChatSessionDrag, isComposerDropTarget, readChatSessionDrop } from './chat-session-dnd'

type DropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>

export function useChatSessionDrop(onAdd: (sessionId: string) => void): {
  active: boolean
  handlers: DropHandlers
} {
  const [active, setActive] = useState(false)
  const depthRef = useRef(0)
  const eligible = useCallback((event: DragEvent) => (
    hasChatSessionDrag(event.dataTransfer) && !isComposerDropTarget(event.target)
  ), [])
  const clear = useCallback(() => {
    depthRef.current = 0
    setActive(false)
  }, [])

  useEffect(() => {
    if (!active) return
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [active, clear])

  const handlers = useMemo<DropHandlers>(() => ({
    onDragEnter: (event) => {
      if (!eligible(event)) return
      event.preventDefault()
      depthRef.current += 1
      setActive(true)
    },
    onDragLeave: (event) => {
      if (!hasChatSessionDrag(event.dataTransfer)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setActive(false)
    },
    onDragOver: (event) => {
      if (!eligible(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (event) => {
      clear()
      if (!eligible(event)) return
      const sessionId = readChatSessionDrop(event.dataTransfer)
      if (!sessionId) return
      event.preventDefault()
      event.stopPropagation()
      onAdd(sessionId)
    },
  }), [clear, eligible, onAdd])

  return { active, handlers }
}

export function ChatGridDropOverlay({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div
      data-testid="chat-grid-drop-zone"
      aria-hidden
      className="pointer-events-none absolute inset-[var(--space-3)] z-30 grid place-items-center rounded-[var(--radius-xl)] bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg-secondary))] shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--accent)_28%,transparent)]"
    >
      <span className="rounded-full bg-[var(--material-thick)] px-4 py-2 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent)] shadow-[var(--shadow-card)]">
        Drop to open beside
      </span>
    </div>
  )
}
