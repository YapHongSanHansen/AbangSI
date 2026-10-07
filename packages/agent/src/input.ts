/**
 * Resolves a buyer request (written prompt + optional file URLs) into the exact
 * job input + quote. Shared by MIP-003 /start_job and x402 so the price, the
 * escrow commitment and the generation all see the same thing:
 *   documents  → video prompt derived from their contents (+ instructions, images)
 *   video+photos → character swap (priced by the video's real length)
 *   image      → image-to-video
 */
import { extractAttachments } from "./attachments.js";
import { promptFromFiles } from "./files.js";
import { quote, rates, type Quote } from "./pricing.js";
import type { VideoInput } from "./store.js";
import { parseVideoInput } from "./video.js";
import { videoSeconds } from "./videoprobe.js";

export function fileUrls(raw: unknown): string[] {
  const d = (raw ?? {}) as Record<string, unknown>;
  const list = [d.files, d.file_urls, d.file].flatMap(v => (Array.isArray(v) ? v : v === undefined ? [] : [v]));
  return list.filter((u): u is string => typeof u === "string" && /^https:\/\//i.test(u.trim())).map(u => u.trim()).slice(0, 12);
}

export async function resolveInput(raw: unknown): Promise<{ input: VideoInput; quote: Quote } | string> {
  const base = parseVideoInput(raw);
  if (typeof base === "string" && !fileUrls(raw).length) return base;
  const d = (raw ?? {}) as Record<string, unknown>;
  const written = typeof d.prompt === "string" ? d.prompt.trim() : "";
  const att = extractAttachments(fileUrls(raw).join(" "));
  if (typeof base === "string" && !att.documents.length) return base; // files alone need at least one document to write from
  let input: VideoInput = typeof base === "string" ? { prompt: "", aspect_ratio: "9:16" } : { ...base };
  if (att.documents.length) {
    const derived = await promptFromFiles(written, att.documents, att.images);
    input = { ...input, prompt: derived.prompt, source_files: derived.sources, prompt_via: derived.via };
  }
  let mode: "text" | "image" | "swap" = "text";
  if (att.videos.length && att.images.length) {
    const seconds = Math.ceil(await videoSeconds(att.videos[0]));
    if (seconds > rates().maxSwapDuration) return `the attached video is ${seconds}s; character swaps support up to ${rates().maxSwapDuration}s`;
    input = { ...input, duration: seconds, reference_video_url: att.videos[0], reference_image_urls: att.images.slice(0, 8) };
    mode = "swap";
  } else if (att.images.length || input.image_url) {
    input = { ...input, image_url: input.image_url ?? att.images[0] };
    mode = "image";
  }
  // Complexity is scored on what the buyer wrote, not on the (always verbose) derived prompt; files add a per-file surcharge.
  const q = quote({ ...input, prompt: att.documents.length ? (written || "short reel") : input.prompt, mode, documents: att.documents.length });
  return { input: { ...input, duration: q.durationSeconds, resolution: q.resolution }, quote: q };
}