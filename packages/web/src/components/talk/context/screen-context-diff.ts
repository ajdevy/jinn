import type { TalkScreenContext } from "./page-snapshot"

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(source)
      .filter((key) => key !== "revision" && key !== "capturedAt")
      .sort()
      .map((key) => [key, stable(source[key])]),
  )
}

export function semanticScreenChanged(previous: TalkScreenContext, next: TalkScreenContext): boolean {
  return JSON.stringify(stable(previous)) !== JSON.stringify(stable(next))
}
