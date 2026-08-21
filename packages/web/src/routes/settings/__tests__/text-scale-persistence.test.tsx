import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, TEXT_SCALES } from "@/lib/settings"
import { SettingsProvider, useSettings } from "@/routes/settings-provider"

vi.mock("@/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: undefined }) }))

function ScaleProbe() {
  const { settings, setTextScale } = useSettings()
  return (
    <button type="button" onClick={() => setTextScale(1.25)}>
      {String(settings.textScale)}
    </button>
  )
}

function mountProvider() {
  return render(
    <SettingsProvider>
      <ScaleProbe />
    </SettingsProvider>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  document.documentElement.style.removeProperty("--text-scale")
})

describe("the persisted text size setting", () => {
  it("ships four steps and defaults to the unscaled one", async () => {
    mountProvider()

    expect(TEXT_SCALES.map((step) => step.value)).toEqual([0.9, 1, 1.1, 1.25])
    expect(DEFAULTS.textScale).toBe(1)
    expect(await screen.findByRole("button", { name: "1" })).not.toBeNull()
  })

  it("hydrates, changes, and reloads the selected step", async () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ textScale: 0.9 }))
    const first = mountProvider()
    const probe = await screen.findByRole("button", { name: "0.9" })

    fireEvent.click(probe)
    await waitFor(() => expect(probe.textContent).toBe("1.25"))
    expect(JSON.parse(localStorage.getItem("jinn-settings") ?? "{}").textScale).toBe(1.25)

    first.unmount()
    mountProvider()
    expect(await screen.findByRole("button", { name: "1.25" })).not.toBeNull()
  })

  it("publishes the step to the document root so the whole UI rescales", async () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ textScale: 1.1 }))

    mountProvider()

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--text-scale")).toBe("1.1"),
    )
  })

  it("falls back to Default when the stored step is junk, absent or out of range", async () => {
    for (const stored of ["huge", 2, 0.1, null, undefined]) {
      localStorage.setItem("jinn-settings", JSON.stringify({ textScale: stored }))
      const mounted = mountProvider()

      expect(await screen.findByRole("button", { name: "1" })).not.toBeNull()
      mounted.unmount()
    }
  })
})
