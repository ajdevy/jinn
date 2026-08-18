import { createLegacyCapacitorAdapter } from "./adapters/legacy-capacitor"
import { createFallbackAdapter } from "./adapters/fallback"
import { createLazyTauriAdapter } from "./adapters/lazy-tauri"
import { createBrowserEnvironment, createWebAdapter } from "./adapters/web"
import { createPlatform, type Platform } from "./contracts"
import { detectRuntime } from "./runtime"

function createDefaultPlatform(): Platform {
  return createPlatform({
    runtime: detectRuntime(),
    adapters: [
      createWebAdapter(createBrowserEnvironment()),
      createLegacyCapacitorAdapter(),
      createLazyTauriAdapter(),
      createFallbackAdapter(),
    ],
  })
}

let currentPlatform: Platform | undefined

export function getPlatform(): Platform {
  return (currentPlatform ??= createDefaultPlatform())
}

export function installPlatform(platform: Platform): () => void {
  const previous = currentPlatform
  currentPlatform = platform
  return () => { currentPlatform = previous }
}
