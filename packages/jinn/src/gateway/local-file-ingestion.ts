import fs from "node:fs"
import path from "node:path"
import { assessFileRead, expandPath, sameInode } from "./files.js"

export type LocalFileIngestion =
  | { ok: true; buffer: Buffer; realPath: string }
  | { ok: false; status: 400 | 403 | 404 | 413; error: string }

function readDescriptor(fd: number, size: number): Buffer | null {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
    if (read <= 0) break
    offset += read
  }
  return offset === buffer.length ? buffer : null
}

function ingestionError(error: unknown, requestedPath: string): LocalFileIngestion {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, status: 404, error: `file not found: ${requestedPath}` }
  if (code === "ELOOP") return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` }
  return { ok: false, status: 400, error: error instanceof Error ? error.message : "read failed" }
}

/** Read one caller-named file through the same descriptor and policy checks as uploads. */
export function readLocalFileForIngestion(requestedPath: string, maxBytes: number): LocalFileIngestion {
  const requested = path.resolve(expandPath(requestedPath))
  let fd: number | null = null
  try {
    const realPath = fs.realpathSync.native(requested)
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const openedStat = fs.fstatSync(fd)
    if (!openedStat.isFile()) return { ok: false, status: 400, error: `not a file: ${requestedPath}` }
    const currentStat = fs.statSync(realPath)
    if (!sameInode(openedStat, currentStat)) return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` }
    const assessment = assessFileRead(realPath, { authenticated: true })
    if (!assessment.allowed) return { ok: false, status: 403, error: assessment.reason || "File read blocked by security policy" }
    if (openedStat.size > maxBytes) return { ok: false, status: 413, error: `attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB per-file limit` }
    const buffer = readDescriptor(fd, openedStat.size)
    if (!buffer) return { ok: false, status: 403, error: `${requestedPath} changed during read and was refused` }
    return { ok: true, buffer, realPath }
  } catch (err) {
    return ingestionError(err, requestedPath)
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}
