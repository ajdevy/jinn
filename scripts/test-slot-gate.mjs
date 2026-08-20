import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A machine-wide cap on concurrently running vitest suites.
 *
 * Several build worktrees running their verify phase at once each spawn a full
 * jsdom suite; four of them put a 10-core machine at load ~60 and every suite
 * (plus the live gateway) crawls into timeout territory. The cap is enforced
 * here — in the shared test runner every worktree checks out — rather than in
 * any one workflow, so it holds no matter who starts the suite.
 *
 * Slots are files under one per-user directory in the OS temp dir, each
 * holding the owner's pid. Acquisition is first-free-slot with stale reclaim:
 * a slot whose pid is dead, or whose file is older than STALE_AFTER_MS, is
 * deleted and retaken. CI runners are one-suite-per-container, so the gate
 * never blocks there; JINN_TEST_MAX_CONCURRENT=0 disables it outright.
 */

export const DEFAULT_LIMIT = 2;
const POLL_MS = 5_000;
const WAIT_LOG_EVERY_MS = 30_000;
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export function slotLimit(env = process.env) {
  const raw = env.JINN_TEST_MAX_CONCURRENT;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_LIMIT;
  return parsed;
}

export function defaultSlotDir() {
  return path.join(os.tmpdir(), "jinn-test-slots");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/** A slot is stale when its owner is gone or the file has outlived any
 *  plausible suite run (pid reuse protection). */
export function slotIsStale(slotPath, now = Date.now()) {
  try {
    const stat = fs.statSync(slotPath);
    if (now - stat.mtimeMs > STALE_AFTER_MS) return true;
    const pid = Number.parseInt(fs.readFileSync(slotPath, "utf8").trim(), 10);
    return !pidAlive(pid);
  } catch {
    // Vanished between listing and reading — someone else reclaimed it.
    return false;
  }
}

function tryClaim(slotPath, pid) {
  try {
    fs.writeFileSync(slotPath, String(pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return false;
    throw error;
  }
}

/** One acquisition pass: claim a free slot, reclaiming stale ones. */
export function tryAcquireSlot({ slotDir, limit, pid, now = Date.now() }) {
  fs.mkdirSync(slotDir, { recursive: true });
  for (let index = 0; index < limit; index += 1) {
    const slotPath = path.join(slotDir, `slot-${index}`);
    if (tryClaim(slotPath, pid)) return slotPath;
    if (slotIsStale(slotPath, now)) {
      fs.rmSync(slotPath, { force: true });
      if (tryClaim(slotPath, pid)) return slotPath;
    }
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Block until a suite slot is free, then hold it for the life of the process.
 * Returns a release function; release also runs on exit/SIGINT/SIGTERM so a
 * killed run frees its slot (and the pid check reclaims a slot from a
 * SIGKILLed one).
 */
export function acquireTestSlot({
  slotDir = defaultSlotDir(),
  limit = slotLimit(),
  pid = process.pid,
  log = (message) => console.log(message),
} = {}) {
  if (limit === 0) return () => {};

  let slotPath = tryAcquireSlot({ slotDir, limit, pid });
  let waitedMs = 0;
  while (slotPath === null) {
    if (waitedMs % WAIT_LOG_EVERY_MS === 0) {
      log(
        `test-slot-gate: all ${limit} machine test slots are busy; waiting so concurrent suites don't starve each other (JINN_TEST_MAX_CONCURRENT=0 disables this).`,
      );
    }
    sleepSync(POLL_MS);
    waitedMs += POLL_MS;
    slotPath = tryAcquireSlot({ slotDir, limit, pid });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.rmSync(/** @type {string} */ (slotPath), { force: true });
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return release;
}
