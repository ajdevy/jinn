import { describe, expect, it } from "vitest"
import { looksLikeId, rankCandidates, searchTerm, spokenId, viewPrefix, type Candidate } from "../resolve"

const CANDIDATES: Candidate[] = [
  { kind: "todo", id: "ABC-744", title: "Talk orb: fuzzy resolution" },
  { kind: "todo", id: "ABC-701", title: "Categories program" },
  { kind: "session", id: "s-1", title: "Talk orb latency bench" },
]

describe("viewPrefix", () => {
  it("reads the namespace off the Todo the operator is looking at", () => {
    expect(viewPrefix("/todos/ABC-744")).toBe("ABC")
    expect(viewPrefix("/todos/abc-744")).toBe("ABC")
  })

  it("has nothing to offer from a route that carries no Todo id", () => {
    expect(viewPrefix("/todos/b/my")).toBeNull()
    expect(viewPrefix("/")).toBeNull()
    expect(viewPrefix("/workflow/nightly-digest")).toBeNull()
  })
})

describe("spokenId", () => {
  it("prefixes a bare number from the view before the instance default", () => {
    expect(spokenId("744", ["ABC", "ZZZ"])).toEqual({ id: "ABC-744" })
  })

  it("falls back to the instance default when the route carries no prefix", () => {
    expect(spokenId("744", [null, "ZZZ"])).toEqual({ id: "ZZZ-744" })
    expect(spokenId(744, [null, "ZZZ"])).toEqual({ id: "ZZZ-744" })
  })

  it("says how to phrase it rather than guessing when there is no prefix at all", () => {
    const resolved = spokenId("744", [null, null])
    expect(resolved).not.toHaveProperty("id")
    expect("error" in resolved && resolved.error).toContain("prefix")
  })

  it("takes a spoken id over either prefix, in the case and spacing speech produces", () => {
    expect(spokenId("ABC-744", [null, null])).toEqual({ id: "ABC-744" })
    expect(spokenId("abc 744", ["ZZZ", "YYY"])).toEqual({ id: "ABC-744" })
  })

  it("rejects a description and an empty string", () => {
    expect("error" in spokenId("the talk orb one", ["ABC"])).toBe(true)
    expect("error" in spokenId("", ["ABC"])).toBe(true)
  })
})

describe("looksLikeId", () => {
  it("is what separates an id the operator gave from a description", () => {
    for (const value of ["744", "ABC-744", "abc 744", " 744 ", 744]) {
      expect(looksLikeId(value), String(value)).toBe(true)
    }
    for (const value of ["the talk orb one", "nightly-digest", ""]) {
      expect(looksLikeId(value), value).toBe(false)
    }
  })
})

describe("searchTerm", () => {
  it("picks the most distinctive spoken word, because the endpoints match substrings", () => {
    expect(searchTerm("the talk orb ticket")).toBe("talk")
  })

  it("has nothing to search for when every word is filler", () => {
    expect(searchTerm("the one about it")).toBeNull()
    expect(searchTerm("")).toBeNull()
  })
})

describe("rankCandidates", () => {
  it("keeps only what the description actually touches, best first", () => {
    const ranked = rankCandidates("talk orb resolution", CANDIDATES)
    expect(ranked.map((candidate) => candidate.id)).toEqual(["ABC-744", "s-1"])
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })

  it("returns nothing rather than a weak guess when no word lands", () => {
    expect(rankCandidates("the deployment pipeline", CANDIDATES)).toEqual([])
  })

  it('ignores filler, so "the one" cannot match everything there is', () => {
    expect(rankCandidates("the one", CANDIDATES)).toEqual([])
  })
})
