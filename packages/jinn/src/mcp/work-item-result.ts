import { assertBoundCaller, JinnMcpToolError, type JinnMcpContext } from "./toolkit.js";

/**
 * What every Todo tool does with a gateway response: turn a mutation into a
 * result the caller can act on, and turn a failure into an error that says what
 * was refused and by which status. Shared by the Todo tools and the label tools
 * so the two surfaces answer a 403 or a 409 in exactly the same words.
 */

const ACTIVITY_RECEIPT_HINT = "Preview or Open the persisted activity receipt in this chat.";

export function assertIdentity(ctx: JinnMcpContext): void {
  assertBoundCaller(ctx);
}

export function asText(body: unknown, max = 1200): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function mutationResult(body: unknown, hint: string): Record<string, unknown> {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : { result: body };
  return { ...value, hint: `${hint} ${ACTIVITY_RECEIPT_HINT}` };
}

export function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail || "not found"}`);
  if (status === 409) return new JinnMcpToolError(`${what} conflicted (409): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}
