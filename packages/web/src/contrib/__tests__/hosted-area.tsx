import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { contributions } from "../registry"

/* The contract every hosted area owes a plugin, written once and asserted
 * against each host that mounts a Slot. Four hosts spelling this out
 * separately is four chances for one of them to quietly stop honouring it. */

/** Everything registered here is stamped as a plugin, because a contribution
 *  arriving at a host area is what a plugin actually is. */
const FIXTURE = "plugin:fixture" as const

const PROBE_PREFIX = "probe-"

interface Probe {
  id: string
  order?: number
  render?: () => ReactNode
}

/** Register probes into one area. Returns the disposer. */
export function contributeProbes(area: string, probes: readonly Probe[]): () => void {
  return contributions.registerMany(
    probes.map((probe) => ({
      ...probe,
      area,
      render: probe.render ?? (() => <span data-testid={`${PROBE_PREFIX}${probe.id}`}>{probe.id}</span>),
    })),
    FIXTURE,
  )
}

/** A probe that throws instead of rendering, for the boundary assertion. */
export function throwingProbe(id: string, message: string): Probe {
  return {
    id,
    render: () => {
      throw new Error(message)
    },
  }
}

/** The ids of the probes currently in the document, in DOM order. */
export function probeOrder(): string[] {
  return [...document.querySelectorAll(`[data-testid^='${PROBE_PREFIX}']`)].map((node) =>
    node.getAttribute("data-testid")!.slice(PROBE_PREFIX.length),
  )
}

interface HostedArea {
  /** The area id the host mounts. */
  area: string
  /** The boundary shape that host passes to its Slot. */
  variant: "chip" | "pane"
  /** Render the host. Called after the probes are registered. */
  renderHost: () => Promise<void>
  /**
   * Something the host renders itself. It is read after a contribution has
   * thrown, which is the half of error isolation a boundary test usually
   * forgets: the fallback showing up proves containment, and this proves the
   * host it was contained inside is still standing.
   */
  findHostContent: () => Promise<HTMLElement>
}

/** Assert one host honours the area contract: it renders contributions, it
 *  orders them, and it contains one that fails. */
export function describeHostedArea(hostName: string, host: HostedArea): void {
  describe(`${hostName} hosts ${host.area}`, () => {
    let dispose: (() => void) | null = null

    afterEach(() => {
      dispose?.()
      dispose = null
    })

    it("renders a contribution the fixture plugin registered", async () => {
      dispose = contributeProbes(host.area, [{ id: "widget" }])

      await host.renderHost()

      expect(probeOrder()).toEqual(["widget"])
    })

    it("orders by `order` ascending, and keeps registration order for a tie", async () => {
      dispose = contributeProbes(host.area, [
        { id: "late", order: 20 },
        { id: "early", order: 10 },
        // Registered b-before-a so a pass cannot come from sorting on the id.
        { id: "tie-b", order: 30 },
        { id: "tie-a", order: 30 },
      ])

      await host.renderHost()

      expect(probeOrder()).toEqual(["early", "late", "tie-b", "tie-a"])
    })

    it("contains a contribution that throws, and keeps rendering the host", async () => {
      // React logs every error a boundary catches; the run stays readable and
      // the captured tag doubles as proof the boundary named the contribution.
      const logged: string[] = []
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === "string") logged.push(args[0])
      })

      dispose = contributeProbes(host.area, [
        { ...throwingProbe("explodes", "the contribution gave up"), order: 10 },
        { id: "survivor", order: 20 },
      ])

      await host.renderHost()

      if (host.variant === "chip") {
        const chip = document.querySelector("[aria-label='Retry explodes']")
        expect(chip).not.toBeNull()
        expect(chip!.getAttribute("title")).toBe("explodes: the contribution gave up")
      } else {
        expect([...document.querySelectorAll("p")].map((p) => p.textContent)).toContain(
          "explodes failed to render",
        )
      }
      expect(logged).toContain("[contrib:explodes]")
      expect(probeOrder()).toEqual(["survivor"])
      expect(await host.findHostContent()).toBeTruthy()

      vi.restoreAllMocks()
    })
  })
}
