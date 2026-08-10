import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// JINN_HOME has to be set before anything reaches paths.js, which reads it once.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugins-watcher-"));
process.env.JINN_HOME = tmpHome;
const pluginsDir = path.join(tmpHome, "plugins");

/** The watcher's own interval, plus room for chokidar to deliver the event. */
const PAST_DEBOUNCE_MS = 900;
/** Long enough for chokidar to have delivered a local mkdir and armed the timer,
 *  short enough to stop the watchers well before that timer would fire. */
const SETTLE_MS = 200;
/** chokidar treats everything it finds before it is ready as pre-existing, and
 *  `ignoreInitial` drops those. Changes made before then would go unseen. */
const READY_MS = 400;

type Watcher = typeof import("../watcher.js");
let watcher: Watcher;
const changes = vi.fn();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startWatching(): Promise<void> {
  watcher.startWatchers({
    onConfigReload: () => {},
    onCronReload: () => {},
    onOrgChange: () => {},
    onSkillsChange: () => {},
    onPluginsChange: changes,
  });
  await wait(READY_MS);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "config.yaml"), "gateway: {}\n");
  watcher = await import("../watcher.js");
});

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  changes.mockClear();
});

afterEach(async () => {
  await watcher.stopWatchers();
});

describe("debounce", () => {
  it("collapses a burst into one call", async () => {
    const fired = vi.fn();
    const debounced = watcher.debounce(fired, 50);
    debounced();
    debounced();
    debounced();
    await wait(120);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("cancel disarms a pending call", async () => {
    const fired = vi.fn();
    const debounced = watcher.debounce(fired, 50);
    debounced();
    debounced.cancel();
    await wait(120);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe("the plugins watcher", () => {
  it("rescans once per debounce window however many directories land in it", async () => {
    await startWatching();
    fs.mkdirSync(path.join(pluginsDir, "alpha"));
    fs.mkdirSync(path.join(pluginsDir, "beta"));
    await wait(PAST_DEBOUNCE_MS);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("rescans when a plugin directory is removed", async () => {
    fs.mkdirSync(path.join(pluginsDir, "alpha"));
    await startWatching();
    fs.rmSync(path.join(pluginsDir, "alpha"), { recursive: true, force: true });
    await wait(PAST_DEBOUNCE_MS);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("fires no rescan after shutdown, even for a change that landed inside the window", async () => {
    await startWatching();
    fs.mkdirSync(path.join(pluginsDir, "alpha"));
    await wait(SETTLE_MS);

    await watcher.stopWatchers();
    await wait(PAST_DEBOUNCE_MS);
    expect(changes).not.toHaveBeenCalled();
  });
});
