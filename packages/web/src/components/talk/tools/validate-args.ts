import type { ToolArgs, ToolParameters, ToolProperty } from "./tool-spec"

/**
 * Argument parsing for a tool call, as a value rather than an exception.
 *
 * A voice model produces arguments as a JSON string it wrote itself, so every
 * failure mode here is one the model can recover from — which is why each error
 * says what the right shape would have been instead of only what was wrong.
 */

export type ArgsParse = { ok: true; args: ToolArgs } | { ok: false; error: string }

function example(parameters: ToolParameters): string {
  const first = Object.entries(parameters.properties)[0]
  if (!first) return "{}"
  const [key, property] = first
  const value = property.enum?.[0] ?? (property.type === "string" ? "value" : 1)
  return JSON.stringify({ [key]: value })
}

function accepted(parameters: ToolParameters): string {
  const keys = Object.keys(parameters.properties)
  return keys.length > 0 ? keys.join(", ") : "no arguments"
}

/** Speech has no types: a model transcribing "fifty-nine" may emit `59` for an
 *  argument declared as a string. Coerce that one direction and no other. */
function coerce(value: unknown, property: ToolProperty): unknown {
  if (property.type === "string" && typeof value === "number") return String(value)
  return value
}

function stringError(property: ToolProperty, value: unknown): string | null {
  if (typeof value !== "string") return "must be a string"
  if (property.enum && !property.enum.includes(value)) return `must be one of: ${property.enum.join(", ")}`
  return null
}

function numberError(property: ToolProperty, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `must be a ${property.type}`
  if (property.type === "integer" && !Number.isInteger(value)) return "must be a whole integer"
  return null
}

function typeError(property: ToolProperty, value: unknown): string | null {
  if (property.type === "string") return stringError(property, value)
  if (property.type === "boolean") return typeof value === "boolean" ? null : "must be true or false"
  return numberError(property, value)
}

function validate(toolName: string, parameters: ToolParameters, raw: ToolArgs): ArgsParse {
  const args: ToolArgs = {}
  for (const [key, value] of Object.entries(raw)) {
    const property = parameters.properties[key]
    if (!property) {
      return {
        ok: false,
        error: `"${toolName}" has no argument "${key}". It accepts: ${accepted(parameters)}.`,
      }
    }
    // An optional argument the model chose not to fill arrives as null just as
    // often as it is omitted. Treat the two the same rather than failing on it.
    if (value === null || value === undefined) continue
    const coerced = coerce(value, property)
    const problem = typeError(property, coerced)
    if (problem) {
      return { ok: false, error: `"${toolName}" argument "${key}" ${problem}, but got ${JSON.stringify(value)}.` }
    }
    args[key] = coerced
  }
  for (const key of parameters.required ?? []) {
    if (args[key] === undefined) {
      return {
        ok: false,
        error: `"${toolName}" is missing the required argument "${key}". Call it like ${example(parameters)}.`,
      }
    }
  }
  return { ok: true, args }
}

export function parseToolArgs(toolName: string, parameters: ToolParameters, argsJson: string | undefined): ArgsParse {
  const text = (argsJson ?? "").trim()
  if (text === "") return validate(toolName, parameters, {})

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `Arguments for "${toolName}" were not valid JSON (${detail}). Send a JSON object like ${example(parameters)}.`,
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `Arguments for "${toolName}" must be a JSON object like ${example(parameters)}, not ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    }
  }
  return validate(toolName, parameters, parsed as ToolArgs)
}
