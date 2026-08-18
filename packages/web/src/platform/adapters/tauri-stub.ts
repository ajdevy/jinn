import { createFallbackAdapter } from "./fallback"

/** S2 contract placeholder. S3 replaces this with the narrow bundled-shell adapter. */
export function createTauriStubAdapter() {
  return createFallbackAdapter("tauri-unsupported")
}
