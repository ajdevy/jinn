import { afterEach, describe, expect, it, vi } from "vitest"
import { clearDebugLog, dlog, shareDebugLog } from "../debug-log"
import { createPlatform, type OperationResult, type Runtime } from "@/platform/contracts"
import { createTestAdapter } from "@/platform/adapters/test"
import { installPlatform } from "@/platform"

const runtime: Runtime = {
  container: "browser",
  os: "unknown",
  engine: "unknown",
  secureContext: true,
  appVersion: "test",
  userAgent: "debug-test",
}

const restores: Array<() => void> = []

function useResults(results: Partial<Record<"sharing.share" | "clipboard.copy", OperationResult>>) {
  const adapter = createTestAdapter({ results })
  restores.push(installPlatform(createPlatform({ runtime, adapters: [adapter] })))
  return adapter
}

afterEach(() => {
  while (restores.length) restores.pop()?.()
  clearDebugLog()
  vi.unstubAllGlobals()
})

describe("debug log platform operations", () => {
  it("stops after a performed share", async () => {
    const adapter = useResults({ "sharing.share": { status: "performed" } })

    await shareDebugLog()

    expect(adapter.calls.map((call) => call.kind)).toEqual(["sharing.share"])
  })

  it("treats share cancellation as terminal", async () => {
    const adapter = useResults({ "sharing.share": { status: "cancelled" } })

    await shareDebugLog()

    expect(adapter.calls.map((call) => call.kind)).toEqual(["sharing.share"])
  })

  it("falls back to clipboard for unsupported sharing", async () => {
    const alert = vi.fn()
    vi.stubGlobal("alert", alert)
    const adapter = useResults({
      "sharing.share": { status: "unsupported" },
      "clipboard.copy": { status: "performed" },
    })
    dlog("test", "ready")

    await shareDebugLog()

    expect(adapter.calls.map((call) => call.kind)).toEqual(["sharing.share", "clipboard.copy"])
    expect(alert).toHaveBeenCalledWith("Debug log copied to clipboard (1 entries)")
  })

  it("offers a manual copy when both operations fail", async () => {
    const prompt = vi.fn()
    vi.stubGlobal("prompt", prompt)
    useResults({
      "sharing.share": { status: "failed", error: { code: "share", message: "offline" } },
      "clipboard.copy": { status: "denied", permission: "denied" },
    })

    await shareDebugLog()

    expect(prompt).toHaveBeenCalledWith("Copy this log:", expect.stringContaining("debug-test"))
  })
})
