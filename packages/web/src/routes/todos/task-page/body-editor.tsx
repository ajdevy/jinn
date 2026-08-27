import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"
import { MarkdownView } from "@/components/markdown-view"
import { BODY_CLAMP_PX, BODY_PLACEHOLDER } from "./body-editor-constants"

const LiveBodyEditor = lazy(async () => {
  const module = await import("./live-body-editor")
  return { default: module.LiveBodyEditor }
})

export { BODY_PLACEHOLDER }

/* The read view's own full height, re-read whenever the body reflows.
 * scrollHeight reports it through the clamp, so collapsing never feeds back into
 * the measurement. It is 0 until the first measurement lands, which reads as
 * "short enough" — an unmeasured body renders whole rather than flashing a clamp
 * it may turn out not to need. */
function useFullHeight(body: string | null) {
  const ref = useRef<HTMLDivElement>(null)
  const [fullHeight, setFullHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setFullHeight(element.scrollHeight)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [body])
  return [ref, fullHeight] as const
}

function ShowMoreToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      data-testid="task-body-toggle"
      onClick={onToggle}
      className="focus-ring mt-1 flex min-h-[34px] items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
    >
      {expanded ? "Show less" : "Show more"}
      <ChevronRight
        size={11}
        strokeWidth={2.2}
        aria-hidden
        className={`transition-transform duration-150 ${expanded ? "-rotate-90" : "rotate-90"}`}
      />
    </button>
  )
}

export function BodyEditor({
  body,
  editable,
  isDark,
  onCommit,
  editorRef,
}: {
  body: string | null
  editable: boolean
  isDark: boolean
  onCommit: (markdown: string) => void
  editorRef?: React.MutableRefObject<unknown | null>
}) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [readRef, fullHeight] = useFullHeight(body)
  const readView = body ? (
    <MarkdownView content={body} isDark={isDark} mentions />
  ) : (
    <p className="text-[16px] leading-[1.6] text-[var(--text-quaternary)]">{BODY_PLACEHOLDER}</p>
  )

  if (!editable) return readView

  if (!editing) {
    const collapsible = fullHeight > BODY_CLAMP_PX
    const clamped = collapsible && !expanded
    return (
      <>
        <div
          ref={readRef}
          role="button"
          tabIndex={0}
          data-testid="task-body-read"
          aria-label="Edit description"
          className={`w-full cursor-text text-left outline-none${
            collapsible
              ? " relative overflow-hidden transition-[max-height] duration-300 ease-[var(--ease-smooth)] motion-reduce:transition-none"
              : ""
          }`}
          style={
            collapsible
              ? // Expanded rests at the measured height rather than releasing the
                // bound, because that height is what the transition animates
                // between — and the observer keeps it current, so later growth is
                // never trapped. The 8px absorbs sub-pixel rounding on the last
                // line so expanding cannot leave a hairline clipped.
                { maxHeight: clamped ? BODY_CLAMP_PX : fullHeight + 8 }
              : undefined
          }
          onClick={() => setEditing(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setEditing(true)
          }}
        >
          {readView}
          {clamped && (
            <div
              aria-hidden
              data-testid="task-body-scrim"
              onClick={(event) => {
                // The scrim sits inside the click-to-edit region, so the fade has
                // to claim its own click to mean "reveal" and not "edit".
                event.stopPropagation()
                setExpanded(true)
              }}
              className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg)]"
            />
          )}
        </div>
        {collapsible && <ShowMoreToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />}
      </>
    )
  }

  return (
    <Suspense fallback={<div data-testid="task-body-loading">{readView}</div>}>
      <LiveBodyEditor
        body={body}
        onCommit={onCommit}
        editorRef={editorRef}
        onExit={() => setEditing(false)}
      />
    </Suspense>
  )
}
