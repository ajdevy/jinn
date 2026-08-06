import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { photoBuffer } from "./image-fixture.js";

type CreateSharp = typeof import("sharp")["default"];

const generations = vi.hoisted(() => ({ count: 0 }));

// Real sharp, wrapped so the suite can see how often generation actually ran.
// The byte assertions need genuine output; the cache assertions need the count.
vi.mock("sharp", async () => {
  // sharp is CommonJS, so depending on the interop path the actual module is
  // either the factory itself or a namespace carrying it as `default`.
  const actual = await vi.importActual<{ default?: CreateSharp }>("sharp");
  const create = actual.default ?? (actual as unknown as CreateSharp);
  return {
    default: (...args: Parameters<CreateSharp>) => {
      generations.count += 1;
      return create(...args);
    },
  };
});

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-image-variants-"));
  roots.push(root);
  return root;
}

let photo: string;
let photoRoot: string;

async function loadVariants() {
  return import("../image-variants.js");
}

beforeAll(async () => {
  photoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-image-fixture-"));
  photo = path.join(photoRoot, "photo.jpg");
  fs.writeFileSync(photo, await photoBuffer());
});

afterAll(() => fs.rmSync(photoRoot, { recursive: true, force: true }));

beforeEach(() => {
  vi.resetModules();
  generations.count = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("image variants", () => {
  it("generates a much smaller thumbnail once and serves the cached file afterwards", async () => {
    const variants = await loadVariants();

    const first = await variants.ensureThumbnail(photo, "cached-photo");
    expect(first).toMatch(/thumb\.webp$/);
    expect(generations.count).toBe(1);

    const original = fs.statSync(photo).size;
    const thumbnail = fs.statSync(first!).size;
    expect(thumbnail).toBeLessThan(original * 0.1);

    const second = await variants.ensureThumbnail(photo, "cached-photo");
    expect(second).toBe(first);
    expect(generations.count).toBe(1);
  });

  it("deduplicates concurrent requests for the same thumbnail", async () => {
    const variants = await loadVariants();

    const [left, right] = await Promise.all([
      variants.ensureThumbnail(photo, "concurrent-photo"),
      variants.ensureThumbnail(photo, "concurrent-photo"),
    ]);

    expect(left).toMatch(/thumb\.webp$/);
    expect(right).toBe(left);
    expect(generations.count).toBe(1);
  });

  it("memoises an unreadable image instead of retrying it on every request", async () => {
    const source = path.join(makeRoot(), "corrupt.jpg");
    fs.writeFileSync(source, Buffer.alloc(2048, 9));
    const logger = await import("../../shared/logger.js");
    const warn = vi.spyOn(logger.logger, "warn").mockImplementation(() => {});
    const variants = await loadVariants();

    await expect(variants.ensureThumbnail(source, "corrupt-photo")).resolves.toBeNull();
    expect(generations.count).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(variants.ensureThumbnail(source, "corrupt-photo")).resolves.toBeNull();
    expect(generations.count).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
