import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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

/** Radix keeps its own surfaces mounted until their exit animation ends. The
 *  peek stack is plain state, so the panel needs the same courtesy: the entry
 *  that just left stays rendered under `data-state="closed"` until the animation
 *  reports back through `onExitEnd`. When the panel is running no exit animation
 *  — reduced motion switches it off — the entry goes in the same commit, because
 *  nothing would ever fire the event that releases it. */
export function usePeekPresence(open: PeekEntry | undefined, panel: HTMLElement | null): {
  entry: PeekEntry | undefined
  state: 'open' | 'closed'
  onExitEnd: () => void
} {
  const [leaving, setLeaving] = useState<PeekEntry | undefined>(undefined)
  const [previous, setPrevious] = useState<PeekEntry | undefined>(open)

  // Derived while rendering rather than in an effect. An effect would leave one
  // commit where the panel is neither open nor leaving, and React would unmount
  // it and mount a second one closed — a visible flash, and the modality hooks
  // would lose the element they hold.
  if (open !== previous) {
    setPrevious(open)
    setLeaving(open ? undefined : previous)
  }

  const closing = !open && leaving !== undefined

  useEffect(() => {
    if (!closing || !panel) return
    const { animationName } = window.getComputedStyle(panel)
    if (!animationName || animationName === 'none') setLeaving(undefined)
  }, [closing, panel])

  return {
    entry: open ?? leaving,
    state: open ? 'open' : 'closed',
    onExitEnd: useCallback(() => setLeaving(undefined), []),
  }
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

/** Modal behaviour for the sheet only: the scroll lock and the inert app root.
 *  The rail is beside the thread, not over it, and wants neither. */
function useSheetModality(panel: HTMLElement | null, active: boolean): void {
  useEffect(() => {
    if (!active || !panel) return
    const appRoot = document.getElementById('root')
    const priorInert = appRoot?.inert
    const priorOverflow = document.body.style.overflow
    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = priorOverflow
      if (appRoot) appRoot.inert = priorInert ?? false
    }
  }, [panel, active])
}

/** The sheet's Tab ring. It stands down while a picker sheet is open above the
 *  panel: that sheet is the modal then, and pulling focus back in here would
 *  ring the wrong one. */
function useSheetTabTrap(panel: HTMLElement | null, active: boolean): void {
  useEffect(() => {
    if (!active || !panel) return
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
    return () => document.removeEventListener('keydown', onKeyDown)
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
  'flex flex-col gap-[var(--space-3)] overflow-hidden bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]'

const RAIL = `${SHELL} m-[var(--space-3)] ml-0 w-[372px] flex-none rounded-[var(--radius-xl)] px-[var(--space-4)] pb-[var(--space-5)] pt-[var(--space-4)] motion-safe:data-[state=closed]:animate-rail-out motion-safe:data-[state=open]:animate-rail-in`

const SHEET = `${SHELL} absolute inset-x-0 bottom-0 h-[78vh] rounded-t-[var(--radius-2xl)] px-[var(--space-4)] pb-[calc(var(--space-5)+var(--safe-bottom))] pt-[10px] motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in`

export function PeekPanel() {
  const stack = usePeekStack()
  const sheet = useSheetLayout()
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  // A picker opened from inside the panel owns Escape and the focus ring until
  // it closes: the operator is answering the picker, not the preview.
  const [pickerOpen, setPickerOpen] = useState(false)
  const open = stack?.entries[stack.entries.length - 1]
  const presence = usePeekPresence(open, panel)
  const entry = presence.entry

  // Modality follows the LIVE stack, not what is still on screen: the scroll
  // lock and the inert app root have to lift the moment the panel starts
  // leaving, or the provider cannot put focus back where it came from.
  useSheetModality(panel, Boolean(open) && sheet)
  useSheetTabTrap(panel, Boolean(open) && sheet && !pickerOpen)
  useEscapeToClose(Boolean(open) && !pickerOpen, stack?.close)

  if (!stack || !entry) return null

  const layer: PeekLayerProps = {
    id: entry.id,
    state: presence.state,
    onPanel: setPanel,
    // A child's own animation ending is not this panel leaving.
    onAnimationEnd: (event) => {
      if (event.target === event.currentTarget) presence.onExitEnd()
    },
  }

  const body = (
    <>
      <PeekHeader stack={stack} entry={entry} sheet={sheet} />
      {/* Keyed so following a reference starts the next Todo with no picker
        * open and no half-written state from the one underneath. */}
      <TodoPeek key={entry.id} id={entry.id} sheet={sheet} onPickerOpenChange={setPickerOpen} />
    </>
  )

  return sheet
    ? <PeekSheetLayer {...layer} onScrimClick={stack.close}>{body}</PeekSheetLayer>
    : <PeekRail {...layer}>{body}</PeekRail>
}

/** What both forms need to render themselves and to report their exit. */
interface PeekLayerProps {
  id: string
  state: 'open' | 'closed'
  onPanel: (panel: HTMLElement | null) => void
  onAnimationEnd: (event: { target: EventTarget; currentTarget: EventTarget }) => void
  children?: ReactNode
}

function PeekRail({ id, state, onPanel, onAnimationEnd, children }: PeekLayerProps) {
  return (
    <aside
      ref={onPanel}
      role="dialog"
      aria-label={`Preview of ${id}`}
      data-testid="peek-rail"
      data-state={state}
      onAnimationEnd={onAnimationEnd}
      className={RAIL}
    >
      {children}
    </aside>
  )
}

function PeekSheetLayer({ id, state, onScrimClick, onPanel, onAnimationEnd, children }: PeekLayerProps & {
  onScrimClick: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Tap-outside is a pointer shortcut for the header's Close button, not a
        * second control: naming it would put two "Close preview" buttons in the
        * tree, and the keyboard already has Escape and that button. */}
      <div
        aria-hidden
        data-testid="peek-scrim"
        data-state={state}
        className="absolute inset-0 bg-[var(--scrim)] motion-safe:data-[state=closed]:animate-overlay-out motion-safe:data-[state=open]:animate-overlay-in"
        onClick={onScrimClick}
      />
      <aside
        ref={onPanel}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${id}`}
        data-testid="peek-sheet"
        data-state={state}
        onAnimationEnd={onAnimationEnd}
        className={SHEET}
      >
        {children}
      </aside>
    </div>,
    document.body,
  )
}
