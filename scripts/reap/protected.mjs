// The live state a sweep is judged against, read at runtime and never hardcoded.
//
// Everything protected is discovered from the machine as it is right now: the
// instance registry says which homes are real, each home's `gateway.json` says
// which PIDs belong to it, and lsof says who owns a port we must not disturb.
// A constant here would be a stale answer the day an instance is added.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isThrowawayHome } from "./gateways.mjs"

const DEFAULT_PROTECTED_PORTS = "7777 7788"

export function resolveDefaultHome(env) {
  return env.JINN_HOME ? path.resolve(env.JINN_HOME) : path.join(os.homedir(), ".jinn")
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** Where the gateway keeps the instance directory, mirroring `instances/directory.ts`. */
function hostDataDir(env) {
  const home = os.homedir()
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Jinn")
  if (process.platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Jinn")
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "jinn")
}

/**
 * Every file that could hold the instance directory, most authoritative first:
 * the override, the host-level registry the current schema writes, and the
 * pre-host-registry file inside the home. All three are consulted rather than
 * only the first that resolves — reading one registry too many can only widen
 * the protected set, while missing one reaps a live instance.
 */
export function instancesRegistryPaths(defaultHome, env) {
  return [env.JINN_INSTANCES_REGISTRY, path.join(hostDataDir(env), "instances.json"), path.join(defaultHome, "instances.json")]
    .filter(Boolean)
    .map((file) => path.resolve(file))
}

/**
 * The registry the gateway itself writes. Both shapes are read: the current
 * `{ schemaVersion, instances }` envelope and the bare array that preceded it.
 * Absent or unreadable means no registered instances.
 */
export function readRegisteredInstances(defaultHome, env) {
  // Keyed by home: the registries overlap heavily on a machine that predates the
  // host-level one, and every duplicate would print twice in the spared list.
  const byHome = new Map()
  for (const file of new Set(instancesRegistryPaths(defaultHome, env))) {
    const registry = readJson(file)
    const listed = Array.isArray(registry) ? registry : registry?.instances
    if (!Array.isArray(listed)) continue
    for (const entry of listed) {
      if (typeof entry?.home !== "string") continue
      const home = path.resolve(entry.home)
      if (!byHome.has(home)) byHome.set(home, entry)
    }
  }
  return [...byHome.values()]
}

function directChildren(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
}

/**
 * Homes worth reading a `gateway.json` out of. The registered ones tell us what
 * to protect; the throwaway ones tell us what may go. Both halves are needed —
 * a home we never look at produces PIDs nothing claims, and an unclaimed PID is
 * spared, so a missed home leaks rather than misfires.
 */
export function discoverHomes({ defaultHome, registered, throwawayRoots }) {
  const homes = new Set([defaultHome, ...registered.map((entry) => path.resolve(entry.home))])
  for (const root of [...throwawayRoots, os.homedir()]) {
    for (const entry of directChildren(root)) {
      const home = path.join(root, entry.name)
      if (isThrowawayHome(home, throwawayRoots)) homes.add(home)
    }
  }
  return [...homes]
}

/** `pid → home` from every discoverable `gateway.json`: the live `pid` plus every `ptyPids` entry. */
export function mapPidsToHomes(homes) {
  const homeByPid = {}
  for (const home of homes) {
    const gateway = readJson(path.join(home, "gateway.json"))
    if (!gateway) continue
    for (const pid of [gateway.pid, ...(gateway.ptyPids ?? [])]) {
      if (Number.isInteger(pid)) homeByPid[pid] = home
    }
  }
  return homeByPid
}

/**
 * Whoever is listening on a protected port, whatever its home claims. Ports come
 * from the registry as well as the constants, so a new instance protects itself.
 * `JINN_REAP_PROTECTED_PORTS` uses `-` rather than `:-` on purpose: a test sets
 * it empty to disable live probing, and `:-` would silently restore the defaults.
 */
export function protectedPortOwners(registered, env) {
  const configured = (env.JINN_REAP_PROTECTED_PORTS ?? DEFAULT_PROTECTED_PORTS).split(/\s+/).filter(Boolean)
  const ports = new Set([...configured, ...registered.map((entry) => String(entry.port)).filter(Boolean)])
  const owners = new Set()
  for (const port of ports) {
    for (const pid of listenOwners(port)) owners.add(pid)
  }
  return [...owners]
}

function listenOwners(port) {
  try {
    const found = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return found.split("\n").map(Number).filter(Number.isInteger)
  } catch {
    // lsof exits non-zero when nothing is listening, which is not an error.
    return []
  }
}

export function throwawayRootsFor(env) {
  return [...new Set([os.tmpdir(), env.TMPDIR].filter(Boolean).map((root) => path.resolve(root)))]
}

/** Where to ask about a Todo: the default instance's own gateway, on its own token. */
export function gatewayEndpoint(defaultHome) {
  const gateway = readJson(path.join(defaultHome, "gateway.json"))
  if (!gateway?.url || !gateway?.token) return { url: null, token: null }
  return { url: gateway.url, token: gateway.token }
}

export function buildContext({ env, minAgeMinutes, selfPids, worktreesRoot }) {
  const defaultHome = resolveDefaultHome(env)
  const registered = readRegisteredInstances(defaultHome, env)
  const throwawayRoots = throwawayRootsFor(env)
  return {
    defaultHome,
    registeredHomes: registered.map((entry) => path.resolve(entry.home)),
    homeByPid: mapPidsToHomes(discoverHomes({ defaultHome, registered, throwawayRoots })),
    protectedPortPids: protectedPortOwners(registered, env),
    throwawayRoots,
    worktreesRoot,
    minAgeMinutes,
    selfPids,
  }
}
