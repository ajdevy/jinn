import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useSettings } from "@/routes/settings-provider"
import type { QueryFacetWire, SearchKind } from "@/lib/search-api"
import { KIND_META } from "./global-search/kind-meta"
import { PreviewPane } from "./global-search/preview-pane"
import { ReadBackLine } from "./global-search/read-back-line"
import { ResultList } from "./global-search/result-list"
import { loadRecent, saveRecent, type RecentItem } from "./global-search/recents"
import { recentRows, resultRows, rowTarget, type SearchRow } from "./global-search/rows"
import { useGlobalSearch } from "./global-search/use-global-search"
import { useSearchKeyboard } from "./global-search/use-search-keyboard"

// The palette stays a module rather than becoming `global-search/index.tsx`, so
// `import("./global-search")` and every `@/components/global-search` specifier
// keeps resolving to exactly this file. Its parts live in the sibling directory.
export { STATIC_PAGES, staticPagesFor } from "./global-search/static-pages"

const PALETTE = [
  "flex flex-col overflow-hidden p-0 gap-0 border-0",
  // `sm:max-w-lg` is in the dialog's own base class, so the wide cap needs the
  // same breakpoint to win — a bare max-width loses to it above 640px.
  "top-[88px] translate-y-0 w-[880px] max-w-[calc(100%-2rem)] sm:max-w-[880px] h-[560px]",
  "rounded-[var(--radius-2xl)] bg-[var(--material-thick)] shadow-[var(--shadow-overlay)]",
  "backdrop-blur-[40px] backdrop-saturate-[1.8]",
  "max-[480px]:top-0 max-[480px]:left-0 max-[480px]:translate-x-0",
  "max-[480px]:h-[100dvh] max-[480px]:w-full max-[480px]:max-w-full max-[480px]:rounded-none",
].join(" ")

const SCRIM = "bg-[var(--scrim)] backdrop-blur-[14px] backdrop-saturate-[1.2]"
const PILL = "inline-flex flex-none items-center gap-1.5 rounded-lg bg-[var(--accent-fill)] px-[9px] py-1 text-[13px] font-medium text-[var(--accent)]"
const FOOTER = "flex items-center gap-[15px] bg-[var(--material-thin)] px-5 py-[9px] text-[11.5px] text-[var(--text-quaternary)] max-[480px]:hidden"
const FOOTER_KEY = "font-medium text-[var(--text-tertiary)]"

export interface GlobalSearchProps {
  initialOpen?: boolean
  /** Opens narrowed to one kind, with a pill that widens it again. Wave 4 wires
   *  the Todos filter bar to this; nothing in this wave passes it. */
  initialScope?: SearchKind
}

export function GlobalSearch({ initialOpen = false, initialScope }: GlobalSearchProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Jinn"
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState("")
  const [literal, setLiteral] = useState(false)
  const [scope, setScope] = useState<SearchKind | undefined>(initialScope)
  const [selected, setSelected] = useState(0)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const goTo = useNavigate()

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next)
    if (next) return
    setQuery("")
    setLiteral(false)
    setScope(initialScope)
  }, [initialScope])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "k") return
      e.preventDefault()
      changeOpen(!open)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, changeOpen])

  useEffect(() => { if (open) setRecents(loadRecent()) }, [open])

  const typing = query.trim().length > 0
  const search = useGlobalSearch({ query, scope, literal })
  const rows = useMemo(
    () => (typing ? resultRows(search.data?.results) : recentRows(recents)),
    [typing, search.data, recents],
  )
  const rowKey = rows.map(row => row.key).join(" ")
  useEffect(() => { setSelected(0) }, [rowKey])
  const row = rows[selected]

  const activate = useCallback((target: SearchRow) => {
    const recent = rowTarget(target)
    saveRecent(recent)
    changeOpen(false)
    goTo(recent.href)
  }, [changeOpen, goTo])

  const toggleLiteral = useCallback(() => setLiteral(wasLiteral => !wasLiteral), [])

  /** Facet spans index the query the gateway parsed, so that is what is cut. */
  const removeFacet = useCallback((facet: QueryFacetWire) => {
    const base = search.data?.query ?? query
    setQuery(`${base.slice(0, facet.span.start)}${base.slice(facet.span.end)}`.replace(/\s+/g, " ").trim())
  }, [search.data, query])

  const handleKeyDown = useSearchKeyboard({
    rowCount: rows.length,
    selectedIndex: selected,
    onMove: setSelected,
    onActivate: () => { if (row) activate(row) },
    onToggleLiteral: toggleLiteral,
  })

  const loading = typing && search.isFetching && !search.data
  const hint = typing
    ? "Nothing matched. Try fewer words, or search literally."
    : "Type to search Todos, chats, notes, people, cron and skills."

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className={PALETTE}
        overlayClassName={SCRIM}
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={event => {
          if (!query) return
          event.preventDefault()
          setQuery("")
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Radix requires an accessible title; the field is the visible one. */}
        <DialogTitle className="sr-only">Search {portalName}</DialogTitle>

        <div className="flex items-center gap-[11px] px-5 pb-[15px] pt-[17px] max-[480px]:px-4 max-[480px]:pb-3 max-[480px]:pt-3.5">
          <Search size={18} aria-hidden="true" className="flex-none text-[var(--text-tertiary)]" />
          {scope && (
            <button type="button" data-testid="search-scope-pill" onClick={() => setScope(undefined)} className={PILL}>
              {KIND_META[scope].plural}
              <span aria-hidden="true" className="opacity-55">&times;</span>
              <span className="sr-only">Search everything instead</span>
            </button>
          )}
          <input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={`Search ${portalName}`}
            aria-label={`Search ${portalName}`}
            className="min-w-0 flex-1 bg-transparent text-[21px] tracking-[-0.012em] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] max-[480px]:text-[19px]"
          />
          <span className="flex-none rounded-md bg-[var(--fill-tertiary)] px-[7px] py-[3px] text-[11px] font-medium text-[var(--text-tertiary)]">esc</span>
        </div>

        {search.data && (
          <ReadBackLine parsed={search.data.parsed} onRemoveFacet={removeFacet} onToggleLiteral={toggleLiteral} />
        )}

        <div className="flex min-h-0 flex-1 max-[480px]:flex-col">
          <div className="w-[396px] flex-none overflow-y-auto px-[10px] pb-[10px] pt-0.5 max-[480px]:w-full max-[480px]:flex-1 max-[480px]:px-2">
            <ResultList
              rows={rows}
              selectedIndex={selected}
              onSelect={setSelected}
              onActivate={activate}
              emptyLabel={typing ? "No results" : "Nothing opened from here yet"}
              loading={loading}
            />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--material-thin)] max-[480px]:max-h-[55%] max-[480px]:flex-none max-[480px]:rounded-t-[var(--radius-2xl)] max-[480px]:bg-[var(--material-thick)] max-[480px]:pt-2.5 max-[480px]:shadow-[var(--shadow-overlay)]">
            <div aria-hidden="true" className="mx-auto mb-3.5 hidden h-[5px] w-9 rounded-[3px] bg-[var(--fill-primary)] max-[480px]:block" />
            <PreviewPane row={row} error={search.error} hint={hint} literal={literal} onSearchLiterally={toggleLiteral} />
          </div>
        </div>

        <div className={FOOTER}>
          <span><b className={FOOTER_KEY}>&#8593;&#8595;</b> navigate</span>
          <span><b className={FOOTER_KEY}>&#9166;</b> open</span>
          <span><b className={FOOTER_KEY}>&#8984;&#9166;</b> search literally</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
