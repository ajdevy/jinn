import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { classifyGateway, parsePsDump, planProcessReap } from "../reap/gateways.mjs"

const REAP = fileURLToPath(new URL("../reap-sandboxes.mjs", import.meta.url))

const TEMP = os.tmpdir()
const DEFAULT_HOME = path.join(TEMP, "reap-fixture", ".jinn")
const REGISTERED_HOME = path.join(TEMP, "reap-fixture", ".jinn-second")
const SETTLED_HOME = path.join(os.homedir(), ".jinn-unregistered")
const SANDBOX_HOME = path.join(TEMP, "jinn-sandbox-abc")

const GATEWAY_ARGS = "node /repo/packages/jinn/dist/src/gateway/daemon-entry.js"

/**
 * The fixture context every case starts from. `registeredHomes` deliberately
 * excludes `SETTLED_HOME`: an unregistered home outside the throwaway patterns
 * is the shape that must still be spared.
 */
function context(overrides = {}) {
  return {
    defaultHome: DEFAULT_HOME,
    registeredHomes: [REGISTERED_HOME],
    homeByPid: {},
    protectedPortPids: [],
    throwawayRoots: [TEMP],
    minAgeMinutes: 120,
    selfPids: [],
    ...overrides,
  }
}

function gateway(pid, ageMinutes = 300) {
  return { pid, ppid: 1, ageMinutes, rssKiB: 100000, args: GATEWAY_ARGS }
}

const CASES = [
  {
    name: "a PID inside a registered instance's gateway.json is never reapable",
    candidate: gateway(9001),
    context: context({ homeByPid: { 9001: REGISTERED_HOME } }),
    reap: false,
    reason: "registered-instance",
  },
  {
    name: "a PID whose home is the default home is never reapable",
    candidate: gateway(9002),
    context: context({ homeByPid: { 9002: DEFAULT_HOME } }),
    reap: false,
    reason: "default-home",
  },
  {
    name: "a PID owning a protected port is never reapable",
    candidate: gateway(9003),
    context: context({ homeByPid: { 9003: SANDBOX_HOME }, protectedPortPids: [9003] }),
    reap: false,
    reason: "protected-port",
  },
  {
    name: "a gateway PID mapping to no known home is never reapable",
    candidate: gateway(9004),
    context: context(),
    reap: false,
    reason: "unidentified",
  },
  {
    name: "a known home that matches no throwaway pattern is never reapable",
    candidate: gateway(9005),
    context: context({ homeByPid: { 9005: SETTLED_HOME } }),
    reap: false,
    reason: "home-not-throwaway",
  },
  {
    name: "a home under the system temp dir, older than the age guard, is reapable",
    candidate: gateway(9006),
    context: context({ homeByPid: { 9006: path.join(TEMP, "jinn-home-xyz") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "a jinn-sandbox-* home outside the temp dir is reapable",
    candidate: gateway(9007),
    context: context({ homeByPid: { 9007: path.join(os.homedir(), "jinn-sandbox-abc") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "an upgrade-lab-* home is reapable",
    candidate: gateway(9008),
    context: context({ homeByPid: { 9008: path.join(os.homedir(), "upgrade-lab-7") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "the same throwaway home younger than the age guard is spared",
    candidate: gateway(9006, 9),
    context: context({ homeByPid: { 9006: path.join(TEMP, "jinn-home-xyz") } }),
    reap: false,
    reason: "too-young",
  },
  {
    name: "this process's own tree is never reapable",
    candidate: gateway(9009),
    context: context({ homeByPid: { 9009: SANDBOX_HOME }, selfPids: [9009] }),
    reap: false,
    reason: "self",
  },
]

for (const testCase of CASES) {
  test(`classifyGateway: ${testCase.name}`, () => {
    const verdict = classifyGateway(testCase.candidate, testCase.context)
    assert.deepEqual(verdict, { reap: testCase.reap, reason: testCase.reason })
  })
}

test("parsePsDump keeps the whole command line as one field", () => {
  const dump = `  501     1 02-03:04:05  123456 ${GATEWAY_ARGS} --port 7900\n 9  1 00:30 10 node -e x\n`
  assert.deepEqual(parsePsDump(dump), [
    { pid: 501, ppid: 1, ageMinutes: 3064, rssKiB: 123456, args: `${GATEWAY_ARGS} --port 7900` },
    { pid: 9, ppid: 1, ageMinutes: 1, rssKiB: 10, args: "node -e x" },
  ])
})

test("planProcessReap sweeps a reaped gateway's children and orphaned test workers", () => {
  const processes = [
    gateway(9101),
    gateway(9102),
    { pid: 9103, ppid: 9101, ageMinutes: 300, rssKiB: 900, args: "node /repo/worker.js" },
    { pid: 9104, ppid: 9102, ageMinutes: 300, rssKiB: 900, args: "node /repo/worker.js" },
    { pid: 9105, ppid: 1, ageMinutes: 300, rssKiB: 900, args: "node vitest/dist/worker.js" },
    { pid: 9106, ppid: 1, ageMinutes: 4, rssKiB: 900, args: "node vitest/dist/worker.js" },
  ]
  const plan = planProcessReap(
    processes,
    context({ homeByPid: { 9101: SANDBOX_HOME, 9102: REGISTERED_HOME } }),
  )
  assert.deepEqual(
    plan.targets.map((target) => [target.pid, target.kind, target.reason]),
    [
      [9101, "sandbox-gateway", "throwaway-home"],
      [9103, "gateway-child", "child-of-9101"],
      [9105, "orphan-test-worker", "orphaned"],
    ],
  )
  assert.equal(plan.spared.find((entry) => entry.pid === 9102).reason, "registered-instance")
})

/**
 * The one that matters: a real, live process the plan targets must survive a
 * bare run and die only under `--apply`. Nothing else proves the apply path is
 * gated rather than merely written.
 */
test("a bare run prints the plan and signals nothing; --apply reaps", async (t) => {
  const root = fs.mkdtempSync(path.join(TEMP, "reap-cli-"))
  const home = path.join(root, ".jinn")
  const sandbox = fs.mkdtempSync(path.join(TEMP, "jinn-sandbox-"))
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  t.after(() => {
    victim.kill("SIGKILL")
    worker.kill("SIGKILL")
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "instances.json"), "[]")
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ pid: 1, ptyPids: [] }))
  fs.writeFileSync(path.join(sandbox, "gateway.json"), JSON.stringify({ pid: victim.pid, ptyPids: [] }))
  const psDump = path.join(root, "ps.txt")
  fs.writeFileSync(
    psDump,
    `${victim.pid} 1 05:00:00 90000 ${GATEWAY_ARGS}\n${worker.pid} ${victim.pid} 05:00:00 900 node /repo/worker.js\n`,
  )

  const env = {
    ...process.env,
    JINN_HOME: home,
    JINN_REAP_PS_SOURCE: psDump,
    JINN_REAP_PROTECTED_PORTS: "",
  }
  const run = (...args) =>
    spawnSync(process.execPath, [REAP, "--repo", path.join(root, "repo"), ...args], {
      encoding: "utf8",
      env,
    })

  const dry = run()
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, new RegExp(`REAP\\s+pid=${victim.pid}`))
  assert.match(dry.stdout, /Spared/)
  // A signalled child lingers as a zombie the parent can still `kill(pid, 0)`,
  // so liveness is read off the handle rather than off the process table.
  await settle()
  assert.equal(victim.exitCode ?? victim.signalCode, null, "a bare run must not signal the gateway")
  assert.equal(worker.exitCode ?? worker.signalCode, null, "a bare run must not signal its children")

  const applied = run("--apply", "--grace-seconds", "1")
  assert.equal(applied.status, 0, applied.stderr)
  await waitForExit(victim, "gateway")
  await waitForExit(worker, "child worker")
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

async function waitForExit(child, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((child.exitCode ?? child.signalCode) !== null) return
    await settle()
  }
  assert.fail(`the ${label} survived --apply`)
}
