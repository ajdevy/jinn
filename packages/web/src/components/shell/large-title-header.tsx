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
    <header data-slot="large-title-header">
      <div
        data-slot="large-title-bar"
        className="sticky top-0 z-20 -mx-[var(--space-3)] flex min-h-11 items-center bg-[var(--material-thick)] px-[var(--space-3)] backdrop-blur md:-mx-[var(--space-10)] md:px-[var(--space-10)]"
      >
        <div aria-hidden="true" className={cn("jinn-inline-title pointer-events-none absolute inset-x-0 flex items-center justify-center lg:hidden", INLINE_TITLE_CLASS)}>
          {typeof title === "string" ? title : null}
        </div>
        <div className="relative ml-auto flex items-center gap-2">{trailingSlot}</div>
      </div>
      {leading}
      {large}
      {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
    </header>
  )
}
