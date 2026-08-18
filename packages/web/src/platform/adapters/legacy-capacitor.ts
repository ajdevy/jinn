import type { PlatformAdapter } from "../contracts"
import { createFallbackAdapter } from "./fallback"

interface CapacitorBridge {
  isNativePlatform?: () => boolean
  Plugins?: { Haptics?: { impact(options: { style: string }): Promise<void> } }
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge
  }
}

export function createLegacyCapacitorAdapter(): PlatformAdapter {
  const fallback = createFallbackAdapter("legacy-capacitor")
  return {
    ...fallback,
    capability: async (capability) => {
      const bridge = typeof window === "undefined" ? undefined : window.Capacitor
      const haptics = bridge?.isNativePlatform?.() === true && bridge.Plugins?.Haptics
      const supported = capability === "feedback.selection" && Boolean(haptics)
      return {
        supported,
        permission: "not-applicable",
        configured: supported,
        available: supported,
      }
    },
    perform: async (intent) => {
      if (intent.kind !== "feedback.selection") return { status: "unsupported" }
      const bridge = typeof window === "undefined" ? undefined : window.Capacitor
      const haptics = bridge?.isNativePlatform?.() === true ? bridge.Plugins?.Haptics : undefined
      if (!haptics) return { status: "unsupported" }
      await haptics.impact({ style: "LIGHT" })
      return { status: "performed" }
    },
  }
}
