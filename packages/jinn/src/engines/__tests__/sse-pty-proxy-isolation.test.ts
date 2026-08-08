import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { AddressInfo } from "node:net";
import { SsePtyProxy, type SsePtyProxyOpts } from "../sse-pty-proxy.js";
import { MAX_UPSTREAM_ATTEMPTS } from "../upstream-pool.js";

// Regression tests for PLA-76: a `bad record mac` on one upstream connection took
// the whole engine stream down, and every session drew from ONE module-scope
// socket pool. Two things are covered here that no other suite touches — the
// POOLED first-attempt path (every other suite passes `primaryAgent: false`, so
// production's actual path had zero coverage), and cross-proxy isolation.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Upstream {
  port: number;
  attempts: () => number;
  /** Client-side port per attempt, so a test can tell socket reuse from a new one. */
  sockets: () => number[];
  close: () => Promise<void>;
}

function startUpstream(
  onAttempt: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Upstream> {
  let n = 0;
  const sockets: number[] = [];
  const server = http.createServer((req, res) => {
    n += 1;
    sockets.push(req.socket.remotePort ?? -1);
    req.resume();
    onAttempt(n, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        attempts: () => n,
        sockets: () => sockets,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

function callProxy(
  port: number,
  opts: { agent?: http.Agent | false; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        agent: opts.agent ?? false, headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

const STARVED = { status: -1, body: "STARVED" };
const withDeadline = (p: Promise<{ status: number; body: string }>, ms: number) =>
  Promise.race([p, wait(ms).then(() => STARVED)]);

describe("SsePtyProxy cross-stream isolation and pooled recovery", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  const agents: http.Agent[] = [];
  const clients: http.ClientRequest[] = [];
  const heldUpstreamResponses: http.ServerResponse[] = [];

  afterEach(async () => {
    for (const r of heldUpstreamResponses.splice(0)) { try { r.end(); } catch { /* gone */ } }
    for (const c of clients.splice(0)) c.destroy();
    for (const p of proxies.splice(0)) p.stop();
    for (const u of upstreams.splice(0)) await u.close();
    for (const a of agents.splice(0)) a.destroy();
  });

  /** A proxy pointed at `u`. With no `primaryAgent` it builds its OWN pool — the
   *  production path — and `protocol` keeps that pool plaintext for the fake upstream. */
  const newProxy = (u: Upstream, extra: Partial<SsePtyProxyOpts> = {}) => {
    const p = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: u.port, protocol: "http:" },
      ...extra,
    });
    proxies.push(p);
    return p;
  };

  it("one proxy's wedged streams do not starve another proxy's stream", async () => {
    // Stream A wedges: the upstream answers headers and then goes silent, holding
    // its socket exactly as a corrupted-but-not-yet-errored connection does.
    const upstream = await startUpstream((_n, req, res) => {
      if (req.headers["x-wedge"]) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {}\n\n");
        heldUpstreamResponses.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("B-COMPLETE-BODY");
    });
    upstreams.push(upstream);

    const portA = await newProxy(upstream).start();
    const portB = await newProxy(upstream).start();

    // Saturate proxy A's pool. `maxSockets` is not exported, so drive well past any
    // plausible bound; on a shared pool this leaves nothing for proxy B.
    const wedged = 80;
    for (let i = 0; i < wedged; i++) {
      const r = http.request(
        { hostname: "127.0.0.1", port: portA, path: "/v1/messages", method: "POST", agent: false, headers: { "x-wedge": "1" } },
        (res) => res.resume(),
      );
      r.on("error", () => { /* torn down in afterEach */ });
      r.end("{}");
      clients.push(r);
    }
    for (let i = 0; i < 100 && heldUpstreamResponses.length < wedged; i++) await wait(50);

    const outB = await withDeadline(callProxy(portB), 3000);

    expect(outB.status).toBe(200);
    expect(outB.body).toBe("B-COMPLETE-BODY");
  }, 20000);

  it("a stream aborted mid-flight leaves a sibling proxy's stream intact", async () => {
    let siblingResponse: http.ServerResponse | undefined;
    const upstream = await startUpstream((_n, req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      if (req.headers["x-wedge"]) heldUpstreamResponses.push(res);
      else siblingResponse = res;
    });
    upstreams.push(upstream);

    const portA = await newProxy(upstream).start();
    const portB = await newProxy(upstream).start();

    const reqA = http.request(
      { hostname: "127.0.0.1", port: portA, path: "/v1/messages", method: "POST", agent: false, headers: { "x-wedge": "1" } },
      (res) => res.resume(),
    );
    reqA.on("error", () => { /* we abort it below */ });
    reqA.end("{}");

    const bDone = callProxy(portB);
    for (let i = 0; i < 100 && !siblingResponse; i++) await wait(20);
    reqA.destroy(); // stream A's client goes away mid-flight
    await wait(200);

    siblingResponse?.write('data: {"type":"done"}\n\n');
    siblingResponse?.end();

    const outB = await withDeadline(bDone, 3000);
    expect(outB.status).toBe(200);
    expect(outB.body).toBe('data: {}\n\ndata: {"type":"done"}\n\n');
  }, 20000);

  it("recovers over a POOLED agent when the first attempt dies pre-response", async () => {
    const upstream = await startUpstream((n, _req, res) => {
      if (n === 1) { res.socket?.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("recovered");
    });
    upstreams.push(upstream);
    const port = await newProxy(upstream).start();

    const out = await callProxy(port);

    expect(out.status).toBe(200);
    expect(out.body).toBe("recovered");
    expect(upstream.attempts()).toBe(2);
  });

  it("recovers when the fault outlives the first retry, instead of 502-ing", async () => {
    // The production trace: attempt 0 hit `bad record mac`, the fresh-socket retry
    // hit `socket hang up` one second later, and the CLI got a bare 502.
    const upstream = await startUpstream((n, _req, res) => {
      if (n <= 2) { res.socket?.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("recovered");
    });
    upstreams.push(upstream);
    const port = await newProxy(upstream).start();

    const out = await callProxy(port);

    expect(out.status).toBe(200);
    expect(out.body).toBe("recovered");
    expect(upstream.attempts()).toBe(3);
  });

  it("stops at the attempt budget — a dead upstream 502s without looping", async () => {
    const upstream = await startUpstream((_n, _req, res) => { res.socket?.destroy(); });
    upstreams.push(upstream);
    const port = await newProxy(upstream).start();

    const out = await callProxy(port);
    await wait(500); // any unbounded retry would keep firing past the 502

    expect(out.status).toBe(502);
    expect(upstream.attempts()).toBe(MAX_UPSTREAM_ATTEMPTS);
  });

  it("a superseded attempt that errors again does not fire an extra request", async () => {
    // A retried-past ClientRequest keeps its 'error' listener. Before the fix its
    // closure still satisfied the retry condition, so a second error re-entered
    // the retry branch and issued an upstream request nobody was waiting for.
    let calls = 0;
    const requestFn: SsePtyProxyOpts["requestFn"] = ((_o: unknown, cb: (r: http.IncomingMessage) => void) => {
      calls += 1;
      const attemptNo = calls;
      const request = new EventEmitter() as EventEmitter & Record<string, unknown>;
      request.write = () => true;
      request.destroy = () => {};
      request.setTimeout = () => request;
      request.end = () => {
        if (attemptNo === 1) {
          const fail = () => request.emit("error", new Error("socket hang up"));
          setImmediate(fail);
          setImmediate(fail); // the same dead socket reports twice
          return;
        }
        setImmediate(() => {
          const response = new EventEmitter() as unknown as http.IncomingMessage;
          Object.assign(response, { statusCode: 200, headers: {}, pause: () => {}, resume: () => {} });
          cb(response);
          setImmediate(() => { response.emit("data", Buffer.from("ok")); response.emit("end"); });
        });
      };
      return request as unknown as http.ClientRequest;
    }) as SsePtyProxyOpts["requestFn"];

    const proxy = new SsePtyProxy("test", () => {}, { requestFn, primaryAgent: false });
    proxies.push(proxy);
    const port = await proxy.start();

    const out = await callProxy(port);
    await wait(500);

    expect(out.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("a completed stream's late client abort spares the recycled pooled socket", async () => {
    // Direct guard for the stale-handle hazard: stream A finishes, the pool hands
    // its keep-alive socket to stream B, and only then does A's client hang up.
    let siblingResponse: http.ServerResponse | undefined;
    const upstream = await startUpstream((n, _req, res) => {
      if (n === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("A-OK");
        return;
      }
      siblingResponse = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
    });
    upstreams.push(upstream);

    // ONE shared pool with a single socket, so B provably inherits A's connection.
    const sharedPool = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agents.push(sharedPool);
    const portA = await newProxy(upstream, { primaryAgent: sharedPool }).start();
    const portB = await newProxy(upstream, { primaryAgent: sharedPool }).start();

    const clientPool = new http.Agent({ keepAlive: true });
    agents.push(clientPool);
    expect((await callProxy(portA, { agent: clientPool })).body).toBe("A-OK");

    const bDone = callProxy(portB);
    for (let i = 0; i < 100 && !siblingResponse; i++) await wait(20);
    const [socketA, socketB] = upstream.sockets();
    expect(socketB).toBe(socketA); // B really is on A's recycled socket

    clientPool.destroy(); // A's client connection goes away after A completed
    await wait(200);
    siblingResponse?.write('data: {"type":"done"}\n\n');
    siblingResponse?.end();

    const outB = await withDeadline(bDone, 3000);
    expect(outB.status).toBe(200);
    expect(outB.body).toBe('data: {}\n\ndata: {"type":"done"}\n\n');
  }, 20000);
});
