import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ChevronLeft, X } from 'lucide-react'
import { todoPath } from '@/lib/todo-id'
import { usePeekStack, type PeekEntry, type PeekStack } from './peek-stack'
import { TodoPeek } from './todo-peek'

/* The inspector shell: chrome, geometry and motion, with no knowledge of what
 * it is inspecting beyond picking the body. Desktop gets an in-flow rail beside
 * the thread — non-modal, because the thread stays readable and usable while it
 * is open. The phone gets a scrimmed bottom sheet, which IS modal, so only that
 * form traps focus, locks the scroll and inerts the app behind it. Exactly one
 * of the two is mounted; the breakpoint is read in JS rather than toggled in
 * CSS so the panel's controls never exist twice. */

const SHEET_QUERY = '(max-width: 640px)'

function useSheetLayout(): boolean {
  const [sheet, setSheet] = useState(() => (
    typeof window !== 'undefined' && !!window.matchMedia?.(SHEET_QUERY).matches
  ))

  useEffect(() => {
    const media = window.matchMedia?.(SHEET_QUERY)
    if (!media) return
    const update = () => setSheet(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return sheet
}

function useEscapeToClose(open: boolean, close: (() => void) | undefined): void {
  useEffect(() => {
    if (!open || !close) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])
}

/** Modal behaviour for the sheet only: the Tab ring, the scroll lock and the
 *  inert app root. The rail is beside the thread, not over it, and wants none. */
function useSheetModality(panel: HTMLElement | null, active: boolean): void {
  useEffect(() => {
    if (!active || !panel) return
    const appRoot = document.getElementById('root')
    const priorInert = appRoot?.inert
    const priorOverflow = document.body.style.overflow
    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),[href]')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = priorOverflow
      if (appRoot) appRoot.inert = priorInert ?? false
    }
  }, [panel, active])
}

const ICON_BUTTON =
  'focus-ring grid flex-none place-items-center rounded-[var(--radius-md)] border-none bg-transparent text-[var(--text-tertiary)] outline-none transition-colors duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]'

function PeekHeader({ stack, entry, sheet }: { stack: PeekStack; entry: PeekEntry; sheet: boolean }) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // The sheet covers the app, so focus has to move into it. The rail leaves the
  // caret where it was: pulling focus out of the composer to open a read-only
  // glance would be the wrong trade.
  useEffect(() => {
    if (sheet) closeRef.current?.focus({ preventScroll: true })
  }, [sheet])

  // 28px is the mock's visual size; the sheet grows the hit area to 34px.
  const size = sheet ? 'size-[34px]' : 'size-7'
  return (
    <>
      {sheet && <div aria-hidden className="mx-auto mb-[var(--space-2)] h-1 w-9 flex-none rounded-[2px] bg-[var(--fill-primary)]" />}
      <div className="flex flex-none items-center gap-[var(--space-1)]">
        {stack.entries.length > 1 && (
          <button type="button" aria-label="Back" onClick={stack.pop} className={`${ICON_BUTTON} ${size}`}>
            <ChevronLeft size={15} strokeWidth={2} aria-hidden />
          </button>
        )}
        <span className="font-[family-name:var(--font-code)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {entry.id}
        </span>
        <span className="flex-1" />
        <Link to={todoPath(entry.id)} aria-label={`Open ${entry.id} full`} className={`${ICON_BUTTON} ${size}`}>
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
        </Link>
        <button ref={closeRef} type="button" aria-label="Close preview" onClick={stack.close} className={`${ICON_BUTTON} ${size}`}>
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </>
  )
}

const SHELL =
  'flex flex-col gap-[var(--space-3)] overflow-hidden bg-[var(--bg-secondary)] shadow-[var(--shadow-card)] motion-reduce:animate-none'

const RAIL = `${SHELL} m-[var(--space-3)] ml-0 w-[372px] flex-none rounded-[var(--radius-xl)] px-[var(--space-4)] pb-[var(--space-5)] pt-[var(--space-4)] animate-[peek-rail-in_220ms_var(--ease-snappy)_both]`

const SHEET = `${SHELL} absolute inset-x-0 bottom-0 h-[78vh] rounded-t-[var(--radius-2xl)] px-[var(--space-4)] pb-[calc(var(--space-5)+var(--safe-bottom))] pt-[10px] animate-[peek-sheet-in_240ms_var(--ease-snappy)_both]`

export function PeekPanel() {
  const stack = usePeekStack()
  const sheet = useSheetLayout()
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const entry = stack?.entries[stack.entries.length - 1]

  useSheetModality(panel, Boolean(entry) && sheet)
  useEscapeToClose(Boolean(entry), stack?.close)

  if (!stack || !entry) return null

  const body = (
    <>
      <PeekHeader stack={stack} entry={entry} sheet={sheet} />
      <TodoPeek id={entry.id} />
    </>
  )

  if (!sheet) {
    return (
      <aside ref={setPanel} role="dialog" aria-label={`Preview of ${entry.id}`} data-testid="peek-rail" className={RAIL}>
        {body}
        <style>{PEEK_KEYFRAMES}</style>
      </aside>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      <button
        type="button"
        aria-label="Close preview"
        tabIndex={-1}
        data-testid="peek-scrim"
        className="absolute inset-0 cursor-default border-none bg-[var(--scrim)] p-0"
        onClick={stack.close}
      />
      <aside ref={setPanel} role="dialog" aria-modal="true" aria-label={`Preview of ${entry.id}`} data-testid="peek-sheet" className={SHEET}>
        {body}
      </aside>
      <style>{PEEK_KEYFRAMES}</style>
    </div>,
    document.body,
  )
}

const PEEK_KEYFRAMES = `
  @keyframes peek-rail-in { from { opacity: 0; transform: translateX(16px); } }
  @keyframes peek-sheet-in { from { transform: translateY(100%); } }
`
