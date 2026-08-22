import { describe, it, expect, beforeEach } from "vitest"
import {
  parseBoardParam,
  boardKey,
  boardPath,
  isSameBoard,
  rememberBoardScroll,
  recallBoardScroll,
  clearBoardScrollCache,
  DEFAULT_BOARD_PATH,
} from "../board/board-route"

describe("parseBoardParam", () => {
  it("maps the three reserved keywords", () => {
    expect(parseBoardParam("home")).toEqual({ kind: "home" })
    expect(parseBoardParam("attention")).toEqual({ kind: "attention" })
    expect(parseBoardParam("everything")).toEqual({ kind: "everything" })
  })

  // ICI-1357 renamed the board; every link written before that still resolves.
  it("keeps the retired `my` param pointing at Home", () => {
    expect(parseBoardParam("my")).toEqual({ kind: "home" })
    expect(parseBoardParam("my")).toEqual(parseBoardParam("home"))
  })

  it("treats any other slug as a department board", () => {
    expect(parseBoardParam("platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("customer-success")).toEqual({ kind: "department", slug: "customer-success" })
  })

  it("falls back to Home for empty or malformed params", () => {
    expect(parseBoardParam(undefined)).toEqual({ kind: "home" })
    expect(parseBoardParam("")).toEqual({ kind: "home" })
    expect(parseBoardParam("   ")).toEqual({ kind: "home" })
    expect(parseBoardParam("-bad")).toEqual({ kind: "home" })
    expect(parseBoardParam("has space")).toEqual({ kind: "home" })
  })

  it("normalizes case", () => {
    expect(parseBoardParam("Platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("HOME")).toEqual({ kind: "home" })
    expect(parseBoardParam("MY")).toEqual({ kind: "home" })
  })
})

describe("boardKey / boardPath / isSameBoard", () => {
  it("serializes keywords and department slugs", () => {
    expect(boardKey({ kind: "home" })).toBe("home")
    expect(boardKey({ kind: "department", slug: "platform" })).toBe("platform")
    expect(boardPath({ kind: "attention" })).toBe("/todos/b/attention")
    expect(boardPath({ kind: "department", slug: "platform" })).toBe("/todos/b/platform")
    expect(DEFAULT_BOARD_PATH).toBe("/todos/b/home")
  })

  it("normalizes a legacy /todos/b/my link onto the Home path", () => {
    expect(boardPath(parseBoardParam("my"))).toBe("/todos/b/home")
  })

  it("round-trips parse ⇄ path", () => {
    for (const raw of ["home", "attention", "everything", "platform"]) {
      const id = parseBoardParam(raw)
      expect(parseBoardParam(boardPath(id).split("/").pop()!)).toEqual(id)
    }
  })

  it("compares by key", () => {
    expect(isSameBoard({ kind: "home" }, parseBoardParam("my"))).toBe(true)
    expect(isSameBoard({ kind: "department", slug: "a" }, { kind: "department", slug: "b" })).toBe(false)
  })
})

describe("board scroll cache", () => {
  beforeEach(() => clearBoardScrollCache())

  it("remembers and recalls per board key", () => {
    rememberBoardScroll("platform", 420)
    rememberBoardScroll("home", 12)
    expect(recallBoardScroll("platform")).toBe(420)
    expect(recallBoardScroll("home")).toBe(12)
  })

  it("returns 0 for boards never scrolled", () => {
    expect(recallBoardScroll("everything")).toBe(0)
  })

  it("ignores invalid values", () => {
    rememberBoardScroll("home", Number.NaN)
    rememberBoardScroll("home", -5)
    expect(recallBoardScroll("home")).toBe(0)
  })
})
