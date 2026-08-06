/**
 * Environment-variable indirection for config values that hold secrets.
 *
 * Lets a user write `apiKey: "${OPENAI_API_KEY}"` in config.yaml and keep the
 * key itself in the environment. Shared by the MCP server resolver and the
 * realtime provider factory.
 */

/**
 * Resolve a value that may reference an environment variable.
 * Supports `${VAR_NAME}` and bare `$VAR_NAME`; anything else is returned as-is.
 * An unset variable resolves to `undefined`, never to the literal reference.
 */
export function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
