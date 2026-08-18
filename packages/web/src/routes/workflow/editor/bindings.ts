/* ── binding helpers: plain text ⇄ fixed bindings ─────────────────────────── */

export type BindingWire = { source?: unknown; value?: unknown; path?: unknown; nodeId?: unknown }

export function fixedText(value: unknown): string {
  const binding = value as BindingWire | undefined
  return binding?.source === "fixed" && typeof binding.value === "string" ? binding.value : ""
}

export function withFixed(config: Record<string, unknown>, key: string, text: string, keepEmpty = false): Record<string, unknown> {
  const next = { ...config }
  if (!text && !keepEmpty) delete next[key]
  else next[key] = { source: "fixed", value: text }
  return next
}
