import React, { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { isTodoId, todoPath } from '@/lib/todo-id'
import { requestTodoPreview } from '@/lib/todo-preview'
import { useKnownTodoPrefixes } from '@/components/chat/todo-prefix-context'
import { usePeekStack } from '@/components/peek/peek-stack'

/** A click the browser is meant to keep: a new tab, a new window, a download,
 *  or the middle button. The peek panel lives inside one tab, so these always
 *  stay navigation. */
function isBrowserNavigation(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

/** The one anchor every surface uses to render a Todo id as a reference to that
 *  Todo. Rendering the id also warms its preview, so a hover affordance built on
 *  top of this has the row already in hand instead of opening a request. A plain
 *  left click opens the peek panel where one is mounted; everywhere else — and
 *  for every modified click — the anchor navigates as it always has. An id whose
 *  prefix belongs to no live company board is not a mention: it stays the
 *  caller's fallback (or plain text) and asks the gateway nothing. */
export function TodoMention({ id, fallback }: { id: string; fallback?: React.ReactNode }) {
  const knownPrefixes = useKnownTodoPrefixes()
  const peek = usePeekStack()
  const isLive = isTodoId(id) && knownPrefixes.has(id.slice(0, 3))

  useEffect(() => {
    if (!isLive) return
    // The anchor never reads the preview, so a failed warm costs it nothing —
    // whoever reads the cache surfaces the failure, and the id is forgotten so
    // that read retries. Swallowing here only keeps it off the console.
    requestTodoPreview(id).catch(() => {})
  }, [id, isLive])

  if (!isLive) return fallback ?? id
  return (
    <Link
      to={todoPath(id)}
      title={`Open ${id}`}
      onClick={(event) => {
        if (!peek || isBrowserNavigation(event)) return
        event.preventDefault()
        peek.open({ kind: 'todo', id }, event.currentTarget)
      }}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {id}
    </Link>
  )
}
