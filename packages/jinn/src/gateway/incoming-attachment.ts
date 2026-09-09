import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { FILES_DIR } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import type { Attachment } from "../shared/types.js"
import {
  insertFile,
  type FileMeta,
} from "../sessions/registry.js"
import { mimeFromFilename, sanitizeUploadFilename } from "./files.js"
import { readLocalFileForIngestion } from "./local-file-ingestion.js"

/**
 * Copy a connector-downloaded attachment into durable managed storage and
 * register its metadata. The connector's temporary path is an ingestion
 * detail only; callers must pass the returned id/path to later turns.
 */
export function registerIncomingAttachment(attachment: Attachment): FileMeta | undefined {
  const localPath = attachment.localPath
  if (!localPath) return undefined

  const ingested = readLocalFileForIngestion(localPath, 50 * 1024 * 1024)
  if (!ingested.ok) {
    logger.warn(`Inbound attachment was not registered: ${ingested.error}`)
    return undefined
  }

  const id = crypto.randomUUID()
  const filename = sanitizeUploadFilename(attachment.name || path.basename(ingested.realPath))
  const storageDir = path.join(FILES_DIR, id)
  const storagePath = path.join(storageDir, filename)
  fs.mkdirSync(storageDir, { recursive: true })
  fs.writeFileSync(storagePath, ingested.buffer, { mode: 0o600 })

  const meta = insertFile({
    id,
    filename,
    size: ingested.buffer.length,
    mimetype: attachment.mimeType || mimeFromFilename(filename),
    path: storagePath,
  })
  logger.info(`Registered inbound attachment ${filename} (${id}, ${meta.size} bytes)`)
  return meta
}
