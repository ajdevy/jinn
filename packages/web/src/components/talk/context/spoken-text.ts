/** Strip identifiers and credential-shaped values before text reaches speech. */
export function safeSpokenText(value: unknown, limit = 240): string {
  return (typeof value === "string" ? value.trim() : "")
    .replace(/[«»]/g, "")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(password|secret|api[-_ ]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[identifier]")
    .replace(/\b[0-9a-f]{16,}\b/gi, "[identifier]")
    .slice(0, limit)
}
