export type TalkControlTarget = "gateway" | "browser"

export interface TalkControlOperation {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
  target: TalkControlTarget
  exposure: "always" | "on-intent"
  intent: string
  mutability: "read" | "write" | "effect"
  operatorOnly: boolean
  verification: string
}

export interface TalkControlManifest {
  version: 1
  operations: TalkControlOperation[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isParameters(value: unknown): value is TalkControlOperation["parameters"] {
  if (!isObject(value)) return false
  return [
    value.type === "object",
    value.additionalProperties === false,
    isObject(value.properties),
    Array.isArray(value.required),
  ].every(Boolean)
}

function isOperation(value: unknown): value is TalkControlOperation {
  if (!isObject(value)) return false
  const operation = value as Partial<TalkControlOperation>
  return [
    typeof operation.name === "string",
    typeof operation.description === "string",
    ["gateway", "browser"].includes(operation.target ?? ""),
    ["always", "on-intent"].includes(operation.exposure ?? ""),
    typeof operation.intent === "string",
    ["read", "write", "effect"].includes(operation.mutability ?? ""),
    typeof operation.operatorOnly === "boolean",
    typeof operation.verification === "string",
    isParameters(operation.parameters),
  ].every(Boolean)
}

export function parseTalkControlManifest(value: unknown): TalkControlManifest | null {
  if (!value || typeof value !== "object") return null
  const manifest = value as Partial<TalkControlManifest>
  if (manifest.version !== 1 || !Array.isArray(manifest.operations) || !manifest.operations.every(isOperation)) return null
  const names = manifest.operations.map((operation) => operation.name)
  if (new Set(names).size !== names.length) return null
  return { version: 1, operations: manifest.operations }
}

export function operationByName(manifest: TalkControlManifest, name: string): TalkControlOperation | undefined {
  return manifest.operations.find((operation) => operation.name === name)
}

export function functionTools(manifest: TalkControlManifest) {
  return manifest.operations.map(({ name, description, parameters }) => ({
    type: "function" as const,
    name,
    description,
    parameters,
  }))
}
