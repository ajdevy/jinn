import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useShellChrome } from "./page-scaffold"

const LARGE_TITLE_CLASS =
  "font-[family-name:var(--font-ui)] text-[length:var(--text-large-title)] font-[var(--weight-bold)] leading-[var(--text-large-title--line-height)] tracking-[var(--text-large-title--letter-spacing)] text-[var(--text-primary)]"

const INLINE_TITLE_CLASS =
  "font-[family-name:var(--font-ui)] text-[length:var(--text-headline)] font-[var(--weight-semibold)] leading-[var(--text-headline--line-height)] text-[var(--text-primary)]"

function LargeTitle({ title }: { title: ReactNode }) {
  return (
    <div className={cn("jinn-large-title", LARGE_TITLE_CLASS)}>
      {typeof title === "string" ? <h1>{title}</h1> : title}
    </div>
  )
}

function Subtitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      {children}
    </div>
  )
}

/** The chrome the large title collapses into: page-wide material, the inline
 *  title, and whatever the route puts on the trailing side. */
function TitleBar({ title, trailing }: { title: ReactNode; trailing: ReactNode }) {
  return (
    <div
      data-slot="large-title-bar"
      className="jinn-title-bar sticky z-20 grid min-h-11 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 bg-[var(--material-thick)] backdrop-blur"
    >
      {/* The title centres in the space `trailing` leaves, not on the bar: `1fr`
          floors a track at its own min-content, so the trailing track keeps its
          width while the empty leading one collapses to 0 and the outer tracks
          never match. Matching them wants the trailing width on the leading side,
          which means measuring in JS or mirroring the buttons — neither is worth
          it for a few pixels. What the shrinking title track does buy is
          truncation against the buttons instead of a run underneath them, and the
          bar is a constant 44px, so one line is all it gets.
          `aria-hidden` because the real <h1> is still in the scroll flow above:
          announced, this copy would give the page a second heading. */}
      <div aria-hidden="true" className={cn("jinn-inline-title pointer-events-none col-start-2 truncate text-center lg:hidden", INLINE_TITLE_CLASS)}>
        {typeof title === "string" ? title : null}
      </div>
      <div className="relative col-start-3 flex items-center gap-2 justify-self-end">{trailing}</div>
    </div>
  )
}

export function LargeTitleHeader({
  title,
  subtitle,
  trailing,
  leading,
}: {
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  leading?: ReactNode
}) {
  const chrome = useShellChrome()
  const trailingSlot = (
    <>
      {trailing}
      {chrome.trailingAction}
    </>
  )
  const large = <LargeTitle title={title} />

  if (!chrome.collapse) {
    return (
      <header data-slot="large-title-header" className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {leading}
          {large}
          {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
        </div>
        {trailingSlot}
      </header>
    )
  }

  return (
    // `display: contents` so the bar's containing block is the scrollport rather
    // than this header. A sticky box cannot leave the block it lives in, and this
    // block ends just under the subtitle — which is exactly where the bar used to
    // scroll away instead of taking over.
    <header data-slot="large-title-header" className="contents">
      <TitleBar title={title} trailing={trailingSlot} />
      {leading}
      {large}
      {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
    </header>
  )
}
