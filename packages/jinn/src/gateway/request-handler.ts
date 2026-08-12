import type http from "node:http";
import { handleApiRequest, type ApiContext } from "./api.js";
import { authenticateGatewayRequest, authRequiredForRequest } from "./auth.js";
import { isAllowedCorsOrigin, serveStatic } from "./server.js";

/** What the handler needs from the running gateway. `authRequired` is a call and
 *  not a value because `config.yaml` reloads while the server is up. */
export interface GatewayRequestHandlerDependencies {
  authRequired: () => boolean;
  gatewayAuthToken: string;
  /** The instance home the operator's credentials are read from. */
  home: string;
  apiContext: ApiContext;
  /** Where the built web UI lives. */
  webDir: string;
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const allowed = isAllowedCorsOrigin(origin, req.headers.host);
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Jinn-Bootstrap-Grant");
  }
  return allowed;
}

/** Whether the gateway answered this request with a 401 rather than letting it
 *  reach the routes. */
function rejectedUnauthenticated(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GatewayRequestHandlerDependencies,
): boolean {
  const pathname = (req.url || "/").split("?")[0];
  if (!deps.authRequired() || !authRequiredForRequest(req.method, pathname)) return false;
  const auth = authenticateGatewayRequest(req, deps.gatewayAuthToken, deps.home);
  if (auth.ok) return false;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: auth.reason || "Unauthorized" }));
  return true;
}

/** Static files for the web UI, and the two answers for a path it has nothing at. */
function serveWebUi(req: http.IncomingMessage, res: http.ServerResponse, webDir: string): void {
  if (serveStatic(req, res, webDir)) return;
  const url = req.url || "/";
  if (url === "/" || url === "/index.html") {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * The gateway's HTTP request handler: CORS, then the `OPTIONS` short-circuit,
 * then the auth gate, then the `/api/` dispatch, then static files.
 *
 * That order is itself a security property — `/api/plugins/<id>/*` answers 404
 * versus 200 only to a caller the auth gate has already let through, so an
 * anonymous caller cannot walk the operator's installed plugins off the status
 * code. It lives in an exported function rather than in a closure so a test can
 * run the order instead of describing it.
 *
 * The `/api/` dispatch promise is returned for the same reason; `http.Server`
 * ignores a handler's return value, so this is invisible in production.
 */
export function createGatewayRequestHandler(deps: GatewayRequestHandlerDependencies) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void> => {
    const url = req.url || "/";
    const corsAllowed = setCorsHeaders(req, res);

    if (url.startsWith("/api/") && !corsAllowed) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (rejectedUnauthenticated(req, res, deps)) return;

    if (url.startsWith("/api/")) return handleApiRequest(req, res, deps.apiContext);

    serveWebUi(req, res, deps.webDir);
  };
}
