
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, SquarePen } from 'lucide-react'
import { type ChatTab } from '@/hooks/use-chat-tabs'
// Frosted pill primitives now live in the shared cross-page pill system.
import { PILL_CLASS, PillButton } from '@/components/pill-nav'

export interface ChatHeaderPillsProps {
  /** Conversation title — slim inline title on desktop, centered on the mobile
   *  thread nav bar. */
  title?: string
  /** Hide the thread chrome on mobile (e.g. over the chat-list view, which is the
   *  body and has its own header + the bottom tab bar). */
  hideOnMobile?: boolean

  /** Mobile-only: pop back from the thread to the chat list. */
  onBack?: () => void
  /** In-app way back for a thread opened FROM another session (open-thread
   *  drill-in): the parent's name + a handler that pops the history entry.
   *  Desktop renders it as a quiet chip before the title; mobile turns the
   *  nav-bar back control into `‹ Parent` (iOS previous-screen idiom). Absent
   *  for sidebar-opened sessions — the sidebar IS the navigation. */
  backTo?: { label: string; onClick: () => void }
  /** Start a new chat (compose). */
  onNew: () => void
  /** Desktop-only control for adding another live grid pane. */
  addGridPane?: ReactNode
  /** Existing "more" (…) menu element, rendered as the last pill control. */
  moreMenu?: ReactNode
  /** Mobile Variant C: four fixed working-set chips replace the title/compose track. */
  mobileWorkingSet?: ReactNode

  /** Retained for callers; the in-header tab switcher UI was removed. */
  tabs?: ChatTab[]
  activeIndex?: number
  onSwitch?: (index: number) => void
  onClose?: (index: number) => void
}

// Split a leading "#NNNN - " id prefix off a session title so the desktop title
// can render the id quietly (--text-tertiary) ahead of the name. Titles without
// the prefix (e.g. employee chats) fall through unchanged.
function splitTitleId(title?: string): { id?: string; rest: string } {
  if (!title) return { rest: "" }
  const m = title.match(/^(#\d+)\s*[-–—]\s*(.+)$/)
  return m ? { id: m[1], rest: m[2] } : { rest: title }
}

// The chat thread chrome. The old left toggle pill is gone — the sidebar toggle
// now lives at the top of the nav ribbon, and the conversation title relocates to
// a slim inline title (desktop) / a centered nav-bar title (mobile thread). The
// right actions pill (compose · more) stays.
export function ChatHeaderPills({
  title,
  hideOnMobile,
  onBack,
  backTo,
  onNew,
  addGridPane,
  moreMenu,
  mobileWorkingSet,
}: ChatHeaderPillsProps) {
  // Mobile nav bar: both side tracks are locked to the wider cluster, which is
  // what puts the middle track on the header's centre line. Callback refs keep
  // the observer attached across the back control's two shapes.
  const [backControl, setBackControl] = useState<HTMLElement | null>(null)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const [sideTrack, setSideTrack] = useState(0)

  useLayoutEffect(() => {
    if (!backControl || !actions) return
    // Both clusters are justify-self-aligned, so they stay content-sized and
    // reading them back can never feed a track's width into itself.
    const measure = () =>
      setSideTrack(Math.max(backControl.offsetWidth, actions.offsetWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(backControl)
    observer.observe(actions)
    return () => observer.disconnect()
  }, [backControl, actions])

  return (
    <>
      {/* DESKTOP — slim inline thread title (top-left, plain text, no pill).
          Understated by design: 15px subheadline, semibold, single line, ellipsis.
          h-10 + top-4 puts its vertical center on the same y as the right actions
          pill and the ribbon's logo/toggle slot — one clean horizontal row. A
          drill-in prepends the quiet back chip (skills/cron detail idiom). */}
      <div className="pointer-events-none absolute left-6 top-4 z-10 hidden h-10 max-w-[42vw] items-center gap-2.5 lg:flex xl:max-w-[48vw]">
        {backTo && (
          <button
            type="button"
            onClick={backTo.onClick}
            aria-label={`Back to ${backTo.label}`}
            className="pointer-events-auto inline-flex max-w-[160px] shrink-0 items-center gap-1 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ChevronLeft size={13} strokeWidth={2.4} aria-hidden className="shrink-0" />
            <span className="truncate">{backTo.label}</span>
          </button>
        )}
        {title && (() => {
          const { id, rest } = splitTitleId(title)
          return (
            <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] tracking-[-0.01em] text-[var(--text-primary)]">
              {id && <span className="font-[var(--weight-medium)] text-[var(--text-tertiary)]">{id} </span>}
              {rest}
            </span>
          )
        })()}
      </div>

      {/* DESKTOP — right actions pill: compose · more. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 hidden lg:block">
        <div className={PILL_CLASS}>
          <PillButton onClick={onNew} title="New chat (N)" ariaLabel="New chat">
            <SquarePen size={18} />
          </PillButton>
          {addGridPane}
          {moreMenu}
        </div>
      </div>

      {/* MOBILE — thread nav bar: back · centered title · compose · more. Hidden
          over the list (the tab bar + list header own that screen). No hairline
          at rest; content scrolls under it via the thread's top scrim. Frosted
          on pointer:fine; coarse pointers get the same material composited to
          alpha 1 (--material-thick-opaque) instead, so the backdrop filter stops
          re-rasterising over the scrolling thread. */}
      {!hideOnMobile && (
        <div
          className="absolute inset-x-0 top-0 z-10 lg:hidden"
          style={{ paddingTop: 'max(var(--safe-top), 0px)' }}
        >
          {/* The plain title locks both side tracks to the WIDER cluster, so its
              middle track sits on the header's centre line. The working set
              instead sizes against its real neighbours: mirroring a labelled
              back control would take that width from the four mobile chips. */}
          <div
            className="relative grid h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-[var(--material-thick-opaque)] px-1.5 [@media(pointer:fine)]:bg-[var(--material-thick)] [@media(pointer:fine)]:[backdrop-filter:blur(20px)_saturate(1.3)] [@media(pointer:fine)]:[-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"
            style={mobileWorkingSet
              ? undefined
              : { gridTemplateColumns: `${sideTrack}px minmax(0,1fr) ${sideTrack}px` }}
          >
            {/* Back control. A drill-in reads `‹ Parent` and returns to the
                parent thread (iOS previous-screen-title idiom); otherwise the
                bare chevron pops to the chat list (accessible name in
                aria-label, HIG icons-over-labels). */}
            {backTo ? (
              <button
                ref={setBackControl}
                onClick={backTo.onClick}
                aria-label={`Back to ${backTo.label}`}
                title={`Back to ${backTo.label}`}
                className="inline-flex h-9 max-w-[34vw] shrink-0 items-center justify-self-start gap-0.5 rounded-full pl-1 pr-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:bg-[var(--fill-secondary)]"
              >
                <ChevronLeft size={22} className="shrink-0" />
                <span className="truncate text-[length:var(--text-subheadline)] font-medium">{backTo.label}</span>
              </button>
            ) : (
              <button
                ref={setBackControl}
                onClick={onBack}
                aria-label="Back to chats"
                title="Back to chats"
                className="inline-flex size-9 shrink-0 items-center justify-center justify-self-start rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:bg-[var(--fill-secondary)]"
              >
                <ChevronLeft size={24} className="shrink-0" />
              </button>
            )}
            {mobileWorkingSet ?? (
              <span className="pointer-events-none min-w-0 truncate text-center text-body font-[var(--weight-semibold)] text-[var(--text-primary)]">
                {title}
              </span>
            )}
            <div ref={setActions} className="flex shrink-0 items-center justify-self-end">
              <PillButton onClick={onNew} title="New chat (N)" ariaLabel="New chat">
                <SquarePen size={18} />
              </PillButton>
              {moreMenu}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
