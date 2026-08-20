import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../manifest.js";
import { restoreSnapshot } from "../restore.js";
import { createSnapshot } from "../snapshot.js";
import { HOME_CONTENT, makeHome, registryRowCount } from "./fixture.js";

const scratch: string[] = [];
const AT = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-backup-restore-"));
  scratch.push(dir);
  return dir;
}

const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function snapshotOf(root: string, rows = 23): Promise<{ home: string; snapshot: string }> {
  const home = makeHome(root, "alpha", { registryRows: rows });
  const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT);
  expect(report.status).toBe("ok");
  return { home, snapshot: report.path };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restoreSnapshot", () => {
  it("reproduces every archived file byte for byte", async () => {
    const root = tempDir();
    const { home, snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");

    await restoreSnapshot({ snapshot, home: restored });

    for (const relative of Object.keys(HOME_CONTENT)) {
      const target = path.join(restored, relative);
      expect(fs.existsSync(target), relative).toBe(true);
      expect(sha(target), relative).toBe(sha(path.join(home, relative)));
    }
  });

  it("restores sessions/registry.db with every row the source held", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root, 23);
    const restored = path.join(tempDir(), "home");

    const result = await restoreSnapshot({ snapshot, home: restored });

    expect(result.restoredRegistry).toBe(true);
    const registry = path.join(restored, "sessions", "registry.db");
    expect(registryRowCount(registry)).toBe(23);
    expect(sha(registry)).toBe(readManifest(snapshot).files.find((f) => f.path === "registry.db")!.sha256);
  });

  it("verifies the manifest before extracting, leaving the home untouched", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const archive = fs.readdirSync(snapshot).find((name) => name.startsWith("home."))!;
    fs.writeFileSync(path.join(snapshot, archive), "corrupted");
    const restored = path.join(tempDir(), "home");

    await expect(restoreSnapshot({ snapshot, home: restored })).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(restored)).toBe(false);
  });

  it("refuses a non-empty home unless forced", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");
    fs.mkdirSync(restored, { recursive: true });
    fs.writeFileSync(path.join(restored, "config.yaml"), "port: 1\n");

    await expect(restoreSnapshot({ snapshot, home: restored })).rejects.toThrow(/not empty/);

    await restoreSnapshot({ snapshot, home: restored, force: true });
    expect(fs.readFileSync(path.join(restored, "config.yaml"), "utf8")).toBe(HOME_CONTENT["config.yaml"]);
  });

  it("refuses a home that still looks like a running instance", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");
    fs.mkdirSync(restored, { recursive: true });
    fs.writeFileSync(path.join(restored, "gateway.json"), "{}");

    await expect(restoreSnapshot({ snapshot, home: restored, force: true })).rejects.toThrow(/running instance/);
  });
});
