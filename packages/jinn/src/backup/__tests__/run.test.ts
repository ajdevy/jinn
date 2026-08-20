import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANCE_DIRECTORY_SCHEMA_VERSION } from "../../instances/directory.js";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import { resolveArchiveCodec } from "../codec.js";
import { runBackupRun } from "../run.js";
import { makeHome } from "./fixture.js";

const scratch: string[] = [];
const AT = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-backup-run-"));
  scratch.push(dir);
  return dir;
}

function writeRegistry(root: string, homes: Record<string, string>): string {
  const registryPath = path.join(root, "instances.json");
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION,
    instances: Object.entries(homes).map(([name, home], index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      name, port: 7900 + index, home, createdAt: "2020-01-01T00:00:00.000Z", kind: "workspace", pinned: true,
    })),
  }, null, 2));
  return registryPath;
}

/** A two-home registry, the second of which is left in a state that fails. */
function twoHomes(root: string, options: { breakSecond?: boolean } = {}): string {
  const alpha = makeHome(root, "alpha");
  const beta = makeHome(root, "beta");
  if (options.breakSecond) fs.writeFileSync(path.join(beta, "sessions", "registry.db"), "not a database");
  return writeRegistry(root, { alpha, beta });
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runBackupRun", () => {
  it("snapshots every target in the registry", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");

    const result = await runBackupRun({ root: backups, now: AT, registryPath });

    expect(result.status).toBe("ok");
    expect(result.targets.map((target) => target.name)).toEqual(["alpha", "beta"]);
    for (const target of result.targets) {
      expect(target.status).toBe("ok");
      expect(target.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(target.path, "manifest.json"))).toBe(true);
    }
  });

  it("emits exactly the per-target fields the alerting job reads", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });

    const result = await runBackupRun({ root: path.join(root, "backups"), now: AT, registryPath });

    for (const target of result.targets) {
      expect(Object.keys(target).sort()).toEqual(
        target.status === "ok" ? ["bytes", "name", "path", "status"] : ["bytes", "error", "name", "path", "status"],
      );
    }
  });

  it("keeps going after a failing target and reports the run as failed", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });
    const backups = path.join(root, "backups");

    const result = await runBackupRun({ root: backups, now: AT, registryPath });

    expect(result.status).toBe("failed");
    const [alpha, beta] = result.targets;
    expect(beta!.status).toBe("failed");
    // The healthy target's snapshot is intact and complete, not a casualty.
    expect(alpha!.status).toBe("ok");
    expect(fs.readdirSync(alpha!.path).sort())
      .toEqual([`home.${resolveArchiveCodec().extension}`, "manifest.json", "registry.db"]);
  });

  it("prunes even when a target failed", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });
    const backups = path.join(root, "backups");
    const ancient = path.join(backups, "alpha", "2020-01-01");
    fs.mkdirSync(ancient, { recursive: true });
    fs.writeFileSync(path.join(ancient, "home.tar.gz"), "old");

    const result = await runBackupRun({ root: backups, now: AT, registryPath, retentionDays: 14 });

    expect(result.status).toBe("failed");
    expect(result.retention.removed).toContain(ancient);
    expect(fs.existsSync(ancient)).toBe(false);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("creates the backup root owner-only", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");
    const previousUmask = process.umask(0);
    try {
      await runBackupRun({ root: backups, now: AT, registryPath });
      expectPosixMode(backups, 0o700);
    } finally {
      process.umask(previousUmask);
    }
  });
});
