// Turning a stored file into the attachment descriptor the web UI renders.
// Split out of `files.ts`, which owns the upload, storage and download routes.
import { getFile, type FileMeta } from "../sessions/file-registry.js";
import type { MessageMedia } from "../sessions/registry.js";

function mediaTypeFromMime(mime: string | null): MessageMedia["type"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("video/")) return "video";
  return "file";
}

export function buildMessageMedia(meta: FileMeta): MessageMedia {
  return {
    type: mediaTypeFromMime(meta.mimetype),
    url: `/api/files/${meta.id}`,
    name: meta.filename,
    mimeType: meta.mimetype ?? undefined,
    size: meta.size,
    // Omitted rather than sent as null when unknown: the client reserves a box
    // from the pair only when it has both, and a null pair would have to be
    // re-checked everywhere an absent one already is.
    ...(meta.width !== null && meta.height !== null ? { width: meta.width, height: meta.height } : {}),
  };
}

/** Resolve uploaded file IDs to media descriptors for persisting on a (user) message. */
export function fileIdsToMedia(fileIds: unknown): MessageMedia[] {
  if (!Array.isArray(fileIds)) return [];
  const media: MessageMedia[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (meta) media.push(buildMessageMedia(meta));
  }
  return media;
}
