/**
 * Which derivative of a Todo attachment the download route serves.
 *
 * The query decides: `?poster=1` and `?quality=low` pick video derivatives from
 * video-variants.ts, `?thumb=1` picks an image thumbnail from image-variants.ts,
 * and `?download=1` or a bare URL always serves the stored original. Caching is
 * part of the answer rather than the caller's guess, because a derivative that
 * could not be produced this time silently falls back to the original and that
 * fallback must not be cached for a year under an immutable ETag.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkItemAttachment } from "../work-items/attachments.js";
import { ensureThumbnail, isThumbnailable } from "./image-variants.js";
import { ensureLowVariant, ensurePoster } from "./video-variants.js";

interface Derivative {
  path: string;
  mime: string;
  filename: string;
  /** Names the derivative in the ETag, so a variant switch is a cache miss. */
  variant: string;
  /** A derivative was asked for and could not be produced; serve uncached. */
  isFallback: boolean;
}

export interface AttachmentVariant extends Derivative {
  size: number;
}

function original(attachment: WorkItemAttachment): Derivative {
  return {
    path: attachment.storagePath,
    mime: attachment.mime,
    filename: attachment.filename,
    variant: "original",
    isFallback: false,
  };
}

/** null when a poster was asked for and cannot be produced. */
async function videoDerivative(attachment: WorkItemAttachment, params: URLSearchParams): Promise<Derivative | null> {
  const key = `todo:${attachment.sha256}`;
  if (params.get("poster") === "1") {
    const poster = await ensurePoster(attachment.storagePath, key);
    if (!poster) return null;
    return {
      path: poster,
      mime: "image/jpeg",
      filename: `${path.parse(attachment.filename).name}-poster.jpg`,
      variant: "poster",
      isFallback: false,
    };
  }
  if (params.get("quality") !== "low") return original(attachment);
  const low = ensureLowVariant(attachment.storagePath, key);
  if (!low) return { ...original(attachment), isFallback: true };
  return { path: low, mime: "video/mp4", filename: attachment.filename, variant: "low", isFallback: false };
}

async function imageDerivative(attachment: WorkItemAttachment): Promise<Derivative> {
  const thumbnail = await ensureThumbnail(attachment.storagePath, `todo:${attachment.sha256}`);
  if (!thumbnail) return { ...original(attachment), isFallback: true };
  return {
    path: thumbnail,
    mime: "image/webp",
    filename: `${path.parse(attachment.filename).name}-thumb.webp`,
    variant: "thumb",
    isFallback: false,
  };
}

async function resolveDerivative(
  attachment: WorkItemAttachment,
  params: URLSearchParams,
  download: boolean,
): Promise<Derivative | null> {
  if (download) return original(attachment);
  if (attachment.mime.startsWith("video/")) return videoDerivative(attachment, params);
  if (params.get("thumb") === "1" && isThumbnailable(attachment.mime)) return imageDerivative(attachment);
  return original(attachment);
}

/**
 * Resolve the file to stream for one attachment request. Returns null when a
 * poster was asked for and cannot be produced, because a poster URL that quietly
 * returned the whole video would be worse than a miss.
 */
export async function selectAttachmentVariant(
  attachment: WorkItemAttachment,
  params: URLSearchParams,
  download: boolean,
): Promise<AttachmentVariant | null> {
  const derivative = await resolveDerivative(attachment, params, download);
  if (!derivative) return null;
  return { ...derivative, size: fs.statSync(derivative.path).size };
}
