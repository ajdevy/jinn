import { readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../")
const routesRoot = join(webRoot, "src/routes")
const shellRoot = join(webRoot, "src/components/shell")

const HATCH = /\/\/\s*jinn-shell:\s*ok\b[ \t]+\S/
const LARGE_TITLE = /--text-large-title/
const ACCENT_BUTTON = /bg-\[var\(--accent\)\]/
const ACCENT_CONTRAST = /text-\[var\(--accent-contrast\)\]/
const SHEET_SIGNATURE = /animate-sheet-in|rounded-t-\[var\(--radius-2xl\)\]|rounded-t-\[18px\]/

const KNOWN_SHEETS = new Set([
  "src/routes/todos/new-todo-dialog.tsx",
  "src/routes/todos/pickers/picker-shell.tsx",
  "src/routes/todos/todo-filter-sheet.tsx",
  "src/routes/workflow/editor/inspector.tsx",
  "src/routes/workflow/editor/palette.tsx",
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return []
      return sourceFiles(path)
    }
    if (![".ts", ".tsx"].includes(extname(entry.name)) || entry.name.includes(".test.")) return []
    return [path]
  })
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length
}

function lineAt(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? ""
}

export function largeTitleViolations(source: string, relPath: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(new RegExp(LARGE_TITLE, "g"))) {
    const line = lineOf(source, match.index ?? 0)
    if (HATCH.test(lineAt(source, line))) continue
    found.push(`${relPath}:${line} ${match[0]}`)
  }
  return found
}

export function accentButtonViolations(source: string, relPath: string): string[] {
  const found: string[] = []
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (HATCH.test(text)) continue
    if (ACCENT_BUTTON.test(text) && ACCENT_CONTRAST.test(text)) {
      found.push(`${relPath}:${i + 1} ${text.trim()}`)
    }
  }
  return found
}

export function sheetHits(source: string, relPath: string): string[] {
  if (!SHEET_SIGNATURE.test(source)) return []
  const lines = source.split("\n")
  for (const text of lines) {
    if (HATCH.test(text) && SHEET_SIGNATURE.test(text)) return []
  }
  return [relPath]
}

describe("jinn shell contract", () => {
  it("rule 1 goes red on a hand-rolled large title and green with a reasoned hatch", () => {
    const violation = `<h1 className="md:text-[length:var(--text-large-title)]">Title</h1>`
    expect(largeTitleViolations(violation, "src/routes/fake.tsx")).toEqual([
      "src/routes/fake.tsx:1 --text-large-title",
    ])
    const hatched = `<h1 className="md:text-[length:var(--text-large-title)]">Title</h1> // jinn-shell: ok fixture`
    expect(largeTitleViolations(hatched, "src/routes/fake.tsx")).toEqual([])
  })

  it("rule 2 goes red on a hand-rolled page-level accent button and green with a reasoned hatch", () => {
    const violation = `className="rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]"`
    expect(accentButtonViolations(violation, "src/routes/fake.tsx")).toHaveLength(1)
    const hatched = `className="rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]" // jinn-shell: ok dialog submit`
    expect(accentButtonViolations(hatched, "src/routes/fake.tsx")).toEqual([])
  })

  it("rule 3 goes red on a new bottom sheet outside the enumerated set", () => {
    const source = `className="absolute inset-x-0 bottom-0 rounded-t-[var(--radius-2xl)] animate-sheet-in"`
    expect(sheetHits(source, "src/routes/new-sheet.tsx")).toEqual(["src/routes/new-sheet.tsx"])
    expect(sheetHits(source, "src/routes/todos/todo-filter-sheet.tsx")).toEqual([
      "src/routes/todos/todo-filter-sheet.tsx",
    ])
  })

  it("rule 1 is green on the migrated tree", () => {
    const violations = sourceFiles(routesRoot).flatMap((path) =>
      largeTitleViolations(readFileSync(path, "utf8"), relative(webRoot, path)),
    )
    expect(violations).toEqual([])
  })

  it("rule 2 is green on the migrated tree", () => {
    const violations = sourceFiles(routesRoot).flatMap((path) =>
      accentButtonViolations(readFileSync(path, "utf8"), relative(webRoot, path)),
    )
    expect(violations).toEqual([])
  })

  it("rule 3 is green when only the enumerated bottom sheets remain", () => {
    const found = sourceFiles(routesRoot)
      .flatMap((path) => sheetHits(readFileSync(path, "utf8"), relative(webRoot, path)))
      .sort()
    expect(found).toEqual([...KNOWN_SHEETS].sort())
  })

  it("the collapse is CSS-only: no scroll listener, observer, or collapsed flag", () => {
    const files = sourceFiles(shellRoot)
    const hits: string[] = []
    for (const path of files) {
      const source = readFileSync(path, "utf8")
      const rel = relative(webRoot, path)
      if (/addEventListener\(\s*["']scroll["']/.test(source)) hits.push(`${rel} addEventListener("scroll")`)
      if (/IntersectionObserver/.test(source)) hits.push(`${rel} IntersectionObserver`)
      if (/useState\([^)]*collaps/i.test(source) || /setCollapsed\b/.test(source)) {
        hits.push(`${rel} collapsed useState`)
      }
    }
    expect(hits).toEqual([])
  })

  it("workflow list and todos board both render PrimaryAction with the same data-slot", () => {
    const workflow = readFileSync(join(routesRoot, "workflow/list.tsx"), "utf8")
    const board = readFileSync(join(routesRoot, "todos/board/board-page.tsx"), "utf8")
    expect(workflow).toMatch(/<PrimaryAction\b/)
    expect(board).toMatch(/<PrimaryAction\b/)
    expect(workflow).not.toMatch(/bg-\[var\(--accent\)\].*text-\[var\(--accent-contrast\)\]/)
    expect(readFileSync(join(shellRoot, "primary-action.tsx"), "utf8")).toMatch(/PRIMARY_ACTION_SLOT/)
    expect(readFileSync(join(shellRoot, "primary-action.tsx"), "utf8")).toMatch(/data-slot=\{PRIMARY_ACTION_SLOT\}/)
  })

  it("todos list still wires the virtualizer and useScrollAnchor to the same scroller", () => {
    const page = readFileSync(join(routesRoot, "todos/board/board-page.tsx"), "utf8")
    expect(page).toMatch(/scroll="external"/)
    expect(page).toMatch(/ref=\{listScrollRef\}/)
    expect(page).toMatch(/onScroll=\{onListScroll\}/)
    expect(page).toMatch(/scrollRef=\{listScrollRef\}/)
    const scroll = readFileSync(join(routesRoot, "todos/board/use-board-scroll.ts"), "utf8")
    expect(scroll).toMatch(/useScrollAnchor\(listScrollRef/)
  })
})
