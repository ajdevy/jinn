import type { ServerResponse } from "node:http";
import { pickEncoding, compressBuffer, MIN_COMPRESS_BYTES } from "./compress.js";

/**
 * Response and route-matching helpers shared by api.ts and the per-domain
 * router modules (`<domain>-api.ts`).
 *
 * They live below api.ts rather than in it because a domain module importing
 * `json` from api.ts would be a real runtime import cycle — api.ts imports the
 * domain module to dispatch to it.
 *
 * The contract every domain module follows:
 *
 *  1. One exported `handle<Domain>Api(req, res, route, context): Promise<boolean>`.
 *     `true` means the request was consumed; `false` falls through to api.ts.
 *  2. It receives the already-parsed `ParsedRoute` and never re-parses `req.url`
 *     — one parse means one set of rejection rules for hostile targets.
 *  3. Sends go through `json`/`notFound`/`badRequest`/`serverError` from here. A
 *     module that rolls its own `send` silently drops the gzip/br negotiation.
 *  4. Unexpected errors throw. api.ts's outer try/catch is the only error
 *     boundary; a module that catches to its own shape changes the response for
 *     failures nobody anticipated. Catches that already exist for an *expected*
 *     failure (a corrupt file on disk, say) stay where they are.
 *  5. Operator-only authority stays in api.ts's `operatorOnlyControlPlaneRoute`
 *     table, which runs before dispatch. Auth scattered across domain modules is
 *     how a guard goes missing.
 *  6. The delegation call sits exactly where the route block used to sit in the
 *     dispatch chain, in the same order.
 */

/** The request line api.ts has already parsed, handed down to a domain module. */
export interface ParsedRoute {
  method: string;
  pathname: string;
  url: URL;
}

/** Per-request Accept-Encoding, stashed by handleApiRequest so json() can compress. */
export type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

export function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const enc =
    body.length >= MIN_COMPRESS_BYTES
      ? pickEncoding((res as ResWithEncoding).__acceptEncoding)
      : null;
  if (enc) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": enc,
      Vary: "Accept-Encoding",
    });
    res.end(compressBuffer(enc, body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

export function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

export function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

/**
 * One `:param` segment decoded, or null when it must not be treated as a value:
 * an encoded separator, undecodable input, a traversal segment, or an embedded
 * separator or NUL. Rejecting here is what keeps a param from ever naming a
 * path outside the directory a handler joins it into.
 */
function decodeRouteParam(raw: string): string | null {
  if (/%2f|%5c/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }
  return decoded;
}

export function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const decoded = decodeRouteParam(pathParts[i]);
      if (decoded === null) return null;
      params[patternParts[i].slice(1)] = decoded;
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
