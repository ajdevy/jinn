import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveBin } from "../shared/resolve-bin.js";
import type { ArchiveCodec } from "./codec.js";

/** What a home is worth keeping: configuration and authored content. */
export const ARCHIVE_INCLUDES = ["config.yaml", "cron", "docs", "knowledge", "org", "secrets", "skills"] as const;

/**
 * Reproducible caches and nested checkouts. A skill that vendors its own git
 * clone can be larger than the rest of the home put together, and none of it is
 * content the operator would lose. Each pattern carries a leading wildcard-slash
 * so it matches at any depth in both bsdtar and GNU tar, the top level included,
 * since every entry is emitted relative to the home directory.
 */
export const ARCHIVE_EXCLUDES = [
  "*/node_modules", "*/tmp", "*/uploads", "*/.git", "*/.venv", "*/__pycache__",
] as const;

export interface ArchiveResult {
  uncompressedBytes: number;
  compressedBytes: number;
  sha256: string;
}

function archiveArgv(home: string): string[] {
  const present = ARCHIVE_INCLUDES.filter((entry) => fs.existsSync(path.join(home, entry)));
  if (present.length === 0) throw new Error(`nothing to archive in ${home}`);
  return [
    "-cf", "-", "-C", home,
    ...ARCHIVE_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    ...present.map((entry) => `./${entry}`),
  ];
}

function failed(name: string, code: number | null, stderr: string): Error {
  return new Error(`${name} exited with ${code ?? "a signal"}: ${stderr.trim().split("\n").slice(-3).join("; ")}`);
}

/**
 * Streams `tar` into the codec and straight to disk, so a multi-gigabyte home
 * never lands in memory, and counts both sides of the pipe on the way past -
 * uncompressed bytes are what tells the operator a home is growing, compressed
 * bytes are what fills the disk.
 */
export function createHomeArchive(home: string, destination: string, codec: ArchiveCodec): Promise<ArchiveResult> {
  const argv = archiveArgv(home);
  return new Promise<ArchiveResult>((resolve, reject) => {
    const tar = spawn(resolveBin("tar"), argv, { stdio: ["ignore", "pipe", "pipe"] });
    const compressor = spawn(codec.command, codec.compressArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const output = fs.createWriteStream(destination, { mode: 0o600 });
    const hash = crypto.createHash("sha256");
    const result: ArchiveResult = { uncompressedBytes: 0, compressedBytes: 0, sha256: "" };
    let tarErrors = "";
    let codecErrors = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      tar.kill();
      compressor.kill();
      reject(error);
    };

    tar.stderr.on("data", (chunk: Buffer) => { tarErrors += chunk.toString(); });
    compressor.stderr.on("data", (chunk: Buffer) => { codecErrors += chunk.toString(); });
    tar.stdout.on("data", (chunk: Buffer) => { result.uncompressedBytes += chunk.length; });
    compressor.stdout.on("data", (chunk: Buffer) => {
      result.compressedBytes += chunk.length;
      hash.update(chunk);
    });

    for (const [name, child] of [["tar", tar], ["compressor", compressor]] as const) {
      child.on("error", (error) => fail(new Error(`${name} could not be started: ${error.message}`)));
    }
    tar.on("close", (code) => { if (code !== 0) fail(failed("tar", code, tarErrors)); });
    compressor.on("close", (code) => { if (code !== 0) fail(failed(codec.id, code, codecErrors)); });
    output.on("error", fail);
    output.on("close", () => {
      if (settled) return;
      settled = true;
      result.sha256 = hash.digest("hex");
      resolve(result);
    });

    tar.stdout.pipe(compressor.stdin);
    compressor.stdout.pipe(output);
  });
}

/** Extracts an archive written by {@link createHomeArchive} into `home`. */
export function extractHomeArchive(archive: string, home: string, codec: ArchiveCodec): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const decompressor = spawn(codec.command, codec.decompressArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const tar = spawn(resolveBin("tar"), ["-xf", "-", "-C", home], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      decompressor.kill();
      tar.kill();
      reject(error);
    };

    for (const child of [decompressor, tar]) child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    for (const [name, child] of [["decompressor", decompressor], ["tar", tar]] as const) {
      child.on("error", (error) => fail(new Error(`${name} could not be started: ${error.message}`)));
    }
    decompressor.on("close", (code) => { if (code !== 0) fail(failed(codec.id, code, errors)); });
    tar.on("close", (code) => {
      if (code !== 0) return fail(failed("tar", code, errors));
      if (settled) return;
      settled = true;
      resolve();
    });

    fs.createReadStream(archive).pipe(decompressor.stdin);
    decompressor.stdout.pipe(tar.stdin);
  });
}
