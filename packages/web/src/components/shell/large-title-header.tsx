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
 *  title centred in it, and whatever the route puts on the trailing side. */
function TitleBar({ title, trailing }: { title: ReactNode; trailing: ReactNode }) {
  return (
    <div
      data-slot="large-title-bar"
      className="jinn-title-bar sticky z-20 grid min-h-11 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 bg-[var(--material-thick)] backdrop-blur"
    >
      {/* Three columns with matched outer tracks: the title stays centred on the
          bar rather than on the space `trailing` leaves over, and because its own
          track can shrink to nothing it truncates against the button instead of
          running under it. The bar is a constant 44px, so one line is all it gets. */}
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
