// Todos v2 board routing (slice 6, design-doc §1 + implementation notes).
// Pure helpers: the /todos/b/:board param ⇄ BoardId mapping and the per-board
// scroll cache the board restores on POP/breadcrumb return. No React in here.

/** The four board kinds the switcher serves (design-doc §1.1). */
export type BoardId =
  | { kind: "home" }
  | { kind: "attention" }
  | { kind: "everything" }
  | { kind: "department"; slug: string }

export const DEFAULT_BOARD_PATH = "/todos/b/home"

/** Parse the :board route param. Unknown/empty values fall back to Home rather
 *  than erroring — a stale department link should land somewhere sane, not on a
 *  dead page. `my` is the board Home replaced (ICI-1357); it still parses, so
 *  every link and bookmark written before the rename keeps working. */
export function parseBoardParam(param: string | undefined | null): BoardId {
  const value = (param ?? "").trim().toLowerCase()
  if (!value || value === "home" || value === "my") return { kind: "home" }
  if (value === "attention") return { kind: "attention" }
  if (value === "everything") return { kind: "everything" }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return { kind: "home" }
  return { kind: "department", slug: value }
}

/** The canonical key a BoardId serializes to in the URL (and cache keys). */
export function boardKey(id: BoardId): string {
  return id.kind === "department" ? id.slug : id.kind
}

export function boardPath(id: BoardId): string {
  return `/todos/b/${encodeURIComponent(boardKey(id))}`
}

export function isSameBoard(a: BoardId, b: BoardId): boolean {
  return boardKey(a) === boardKey(b)
}

// ── Per-board scroll cache (design-doc implementation notes) ────────────────
// Module-level so it survives route unmounts within one app session; POP or a
// breadcrumb return restores the exact scrollTop, a fresh PUSH starts at 0.
const scrollByBoard = new Map<string, number>()

export function rememberBoardScroll(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return
  scrollByBoard.set(key, top)
}

export function recallBoardScroll(key: string): number {
  return scrollByBoard.get(key) ?? 0
}

/** Test-only: reset the module cache between cases. */
export function clearBoardScrollCache(): void {
  scrollByBoard.clear()
}
