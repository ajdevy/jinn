import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LIMIT,
  acquireTestSlot,
  slotIsStale,
  slotLimit,
  tryAcquireSlot,
} from "../test-slot-gate.mjs";

function freshSlotDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slot-gate-test-"));
}

test("slotLimit defaults, honors the env var, and treats junk as the default", () => {
  assert.equal(slotLimit({}), DEFAULT_LIMIT);
  assert.equal(slotLimit({ JINN_TEST_MAX_CONCURRENT: "3" }), 3);
  assert.equal(slotLimit({ JINN_TEST_MAX_CONCURRENT: "0" }), 0);
  assert.equal(slotLimit({ JINN_TEST_MAX_CONCURRENT: "off" }), DEFAULT_LIMIT);
  assert.equal(slotLimit({ JINN_TEST_MAX_CONCURRENT: "-4" }), DEFAULT_LIMIT);
});

test("acquisition fills each slot once, then reports the machine full", () => {
  const slotDir = freshSlotDir();
  const first = tryAcquireSlot({ slotDir, limit: 2, pid: process.pid });
  const second = tryAcquireSlot({ slotDir, limit: 2, pid: process.pid });
  assert.ok(first && second && first !== second);
  assert.equal(tryAcquireSlot({ slotDir, limit: 2, pid: process.pid }), null);
});

test("a slot whose owner is dead is reclaimed instead of blocking forever", () => {
  const slotDir = freshSlotDir();
  // 2^30 is far past any real pid table; process.kill reports it dead.
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, "slot-0"), String(2 ** 30));
  assert.equal(slotIsStale(path.join(slotDir, "slot-0")), true);
  const claimed = tryAcquireSlot({ slotDir, limit: 1, pid: process.pid });
  assert.equal(claimed, path.join(slotDir, "slot-0"));
  assert.equal(fs.readFileSync(claimed, "utf8"), String(process.pid));
});

test("a live owner's slot is NOT stale and NOT stolen", () => {
  const slotDir = freshSlotDir();
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, "slot-0"), String(process.pid));
  assert.equal(slotIsStale(path.join(slotDir, "slot-0")), false);
  assert.equal(tryAcquireSlot({ slotDir, limit: 1, pid: process.pid }), null);
});

test("an ancient slot file is stale even when its pid is alive (pid reuse)", () => {
  const slotDir = freshSlotDir();
  fs.mkdirSync(slotDir, { recursive: true });
  const slotPath = path.join(slotDir, "slot-0");
  fs.writeFileSync(slotPath, String(process.pid));
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(slotPath, fourHoursAgo, fourHoursAgo);
  assert.equal(slotIsStale(slotPath), true);
});

test("limit 0 disables the gate: acquire returns immediately with a no-op release", () => {
  const release = acquireTestSlot({ slotDir: freshSlotDir(), limit: 0 });
  assert.equal(typeof release, "function");
  release();
});

test("release frees the slot for the next acquirer", () => {
  const slotDir = freshSlotDir();
  const release = acquireTestSlot({ slotDir, limit: 1, log: () => {} });
  assert.equal(tryAcquireSlot({ slotDir, limit: 1, pid: process.pid }), null);
  release();
  assert.ok(tryAcquireSlot({ slotDir, limit: 1, pid: process.pid }));
});
