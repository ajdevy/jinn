import { afterEach, describe, expect, it, vi } from "vitest"
import { createPlatform, type Runtime } from "../contracts"
import { createLegacyCapacitorAdapter } from "../adapters/legacy-capacitor"

const runtime: Runtime = {
  container: "browser",
  os: "ios",
  engine: "webkit",
  secureContext: true,
  appVersion: "test",
  userAgent: "legacy-test",
}

afterEach(() => {
  Reflect.deleteProperty(window, "Capacitor")
})

describe("transitional legacy feedback adapter", () => {
  it("truthfully supports selection feedback only", async () => {
    const impact = vi.fn(async () => {})
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Haptics: { impact } } }
    const platform = createPlatform({ runtime, adapters: [createLegacyCapacitorAdapter()] })

    await expect(platform.capability("feedback.selection")).resolves.toMatchObject({ supported: true })
    await expect(platform.capability("feedback.impact")).resolves.toMatchObject({ supported: false })
    await expect(platform.perform({ kind: "feedback.selection" })).resolves.toEqual({ status: "performed" })
    await expect(platform.perform({ kind: "feedback.impact", style: "heavy" })).resolves.toEqual({
      status: "unsupported",
    })
    expect(impact).toHaveBeenCalledOnce()
    expect(impact).toHaveBeenCalledWith({ style: "LIGHT" })
  })

  it("normalizes a bridge rejection to failed", async () => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Haptics: { impact: vi.fn(async () => { throw new Error("bridge unavailable") }) } },
    }
    const platform = createPlatform({ runtime, adapters: [createLegacyCapacitorAdapter()] })

    await expect(platform.perform({ kind: "feedback.selection" })).resolves.toEqual({
      status: "failed",
      error: { code: "adapter-error", message: "bridge unavailable" },
    })
  })
})
