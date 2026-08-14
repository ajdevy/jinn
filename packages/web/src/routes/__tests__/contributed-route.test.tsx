import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { contributions } from "@/contrib/registry"
import { AREAS } from "@/contrib/types"
import { scanDiskPlugins } from "@/plugins/disk-plugins"
import { ContributedRoute, contributedRouteFor, firstSegment, reservedSegments } from "../contributed-route"

// The host wraps a contributed page in the app's chrome. That chrome is the
// whole dashboard shell, and these cases are about routing, so it stands in as
// a passthrough — the same substitution the settings suite makes.
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

/**
 * The `routes` host. Two properties matter and are tested as two: a contributed
 * page is reachable, and a contribution that names one of the app's own routes
 * is dropped rather than served in its place.
 */

const RESERVED = reservedSegments(["/", "/settings", "/notes/*", "/todos/:todoId"])

const disposers: (() => void)[] = []
let warn: ReturnType<typeof vi.spyOn>

/** A contribution under an id nothing else has used. The host explains a
 *  rejection once per id for the life of the module, so cases that share one
 *  would be reading each other's console. */
let counter = 0
function contribute(name: string, data: unknown, render?: () => ReactNode): string {
  const id = `${name}-${(counter += 1)}`
  disposers.push(contributions.register({ id, area: AREAS.routes, data, render }, `plugin:${id}`))
  return id
}

const routesArea = () => contributions.getArea(AREAS.routes)

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
})

/* First in the file on purpose: "the plugins have been looked for" is a
 * one-way flag, so the window before it flips can only be observed before
 * anything else settles it. */
describe("before the plugins have been looked for", () => {
  it("waits at an unclaimed URL rather than bouncing a bookmarked plugin page", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/inbox-demo"]}>
        <Routes>
          <Route path="/" element={<p>chat</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(container.textContent).toBe("")
  })
})

describe("reservedSegments", () => {
  it("claims the whole subtree a parameterised or splat route owns", () => {
    expect(firstSegment("/notes/*")).toBe("/notes")
    expect(firstSegment("/todos/:todoId")).toBe("/todos")
    expect([...RESERVED]).toEqual(expect.arrayContaining(["/", "/settings", "/notes", "/todos"]))
  })
})

describe("a contributed path", () => {
  it("resolves to the contribution that claims it", () => {
    const id = contribute("page", { path: "/inbox-demo" }, () => null)

    expect(contributedRouteFor("/inbox-demo", routesArea(), RESERVED)?.id).toBe(id)
  })

  it("renders at that path inside the router", () => {
    contribute("page", { path: "/inbox-demo" }, () => <p>the plugin page</p>)

    render(
      <MemoryRouter initialEntries={["/inbox-demo"]}>
        <Routes>
          <Route path="/settings" element={<p>the real settings page</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("the plugin page")).toBeTruthy()
  })

  it("is dropped when it collides with one of the app's own routes", () => {
    contribute("squatter", { path: "/settings" }, () => <p>the plugin page</p>)

    expect(contributedRouteFor("/settings", routesArea(), RESERVED)).toBeNull()
    expect(warn.mock.calls[0]?.[0]).toContain("/settings")
  })

  it("does not shadow that route when the router matches it", () => {
    contribute("squatter", { path: "/settings" }, () => <p>the plugin page</p>)

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<p>the real settings page</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("the real settings page")).toBeTruthy()
    expect(screen.queryByText("the plugin page")).toBeNull()
  })

  it("is dropped when it is not one plain segment, or has nothing to render", () => {
    contribute("nested", { path: "/a/b" }, () => null)
    contribute("parameterised", { path: "/a/:id" }, () => null)
    contribute("relative", { path: "inbox" }, () => null)
    contribute("renderless", { path: "/renderless" })
    contribute("pathless", {}, () => null)

    for (const pathname of ["/a/b", "/a/:id", "inbox", "/renderless"]) {
      expect(contributedRouteFor(pathname, routesArea(), RESERVED)).toBeNull()
    }
  })

  it("sends a URL nobody claims back to chat rather than to a router error", async () => {
    // One pass, so the host knows the plugins have been looked for. "No gateway"
    // is stubbed rather than left to a real connection refusal: the refusal is
    // what this waited on, and on a loaded machine it does not always come back
    // inside the default timeout. A pass that fails still settles, which is the
    // point.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"))
    await scanDiskPlugins()

    render(
      <MemoryRouter initialEntries={["/nothing-here"]}>
        <Routes>
          <Route path="/" element={<p>chat</p>} />
          <Route path="*" element={<ContributedRoute reserved={RESERVED} />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText("chat")).toBeTruthy()
  })

  it("explains each rejected contribution once, not on every navigation", () => {
    contribute("repeat-squatter", { path: "/settings" }, () => null)

    contributedRouteFor("/settings", routesArea(), RESERVED)
    contributedRouteFor("/settings", routesArea(), RESERVED)
    contributedRouteFor("/elsewhere", routesArea(), RESERVED)

    expect(warn).toHaveBeenCalledTimes(1)
  })
})
