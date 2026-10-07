/**
 * Durable copies: download the generated MP4 server-side (no browser CORS involved), store it content-addressed,
 * and hand the browser a same-site URL that does not expire. The original bytes are never modified.
 */
import fs from "node:fs"

import {config} from "./config.ts"
import {ApiError} from "./errors.ts"
import {putAsset, webStream, saveGenerationRecord, getGenerationRecord, getAsset, type AssetMeta} from "./store.ts"
import {resolveGeneration} from "./generations.ts"

const DEFAULT_IMPORT_HOSTS = ["*.cloudfront.net", "*.higgsfield.ai", "interactive-examples.mdn.mozilla.net"]

export function importHostAllowed(hostname: string) {
	const allowed = [...DEFAULT_IMPORT_HOSTS, ...(process.env.IMPORT_ALLOWED_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean)]
	const host = hostname.toLowerCase()
	return allowed.some(pattern => {
		const p = pattern.toLowerCase()
		return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p
	})
}

function checkUrl(raw: string): URL {
	let u: URL
	try { u = new URL(raw) } catch { throw new ApiError(400, "bad_url", "videoUrl is not a valid URL.") }
	if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError(400, "bad_url", "videoUrl must be http(s).")
	if (u.username || u.password) throw new ApiError(400, "bad_url", "Credentials in URLs are not allowed.")
	if (!importHostAllowed(u.hostname)) {
		throw new ApiError(403, "host_not_allowed", `Downloading from ${u.hostname} is not allowed. Add it to IMPORT_ALLOWED_HOSTS on the server.`)
	}
	return u
}

/** fetch with manual redirects so every hop is re-checked against the host allowlist */
async function fetchAllowed(raw: string): Promise<Response> {
	let url = checkUrl(raw)
	for (let hop = 0; hop < 4; hop++) {
		let res: Response
		try {
			res = await fetch(url, {redirect: "manual", signal: AbortSignal.timeout(120_000), headers: {Accept: "video/*,*/*;q=0.5"}})
		} catch (e) {
			throw new ApiError(502, "source_unreachable", `The video URL could not be reached from the server (${(e as Error).name}).`)
		}
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			url = checkUrl(new URL(res.headers.get("location")!, url).href)
			continue
		}
		return res
	}
	throw new ApiError(502, "too_many_redirects", "Too many redirects while downloading the video.")
}

export async function downloadToStore(videoUrl: string, meta: {generationId?: string, name?: string}): Promise<AssetMeta> {
	const res = await fetchAllowed(videoUrl)
	if (res.status === 403 || res.status === 404 || res.status === 410) {
		throw new ApiError(410, "source_expired", `The generated video URL is no longer available (HTTP ${res.status}). It has probably expired; regenerate or use the stored copy.`)
	}
	if (!res.ok || !res.body) throw new ApiError(502, "source_http_error", `Downloading the video failed (HTTP ${res.status}).`)
	const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
	if (type && !type.startsWith("video/") && type !== "application/octet-stream" && type !== "binary/octet-stream") {
		throw new ApiError(422, "not_a_video", `The URL did not return a video (Content-Type ${type}).`)
	}
	const length = Number(res.headers.get("content-length") ?? 0)
	if (length > config.maxDownloadBytes) throw new ApiError(413, "too_large", "The video is too large.")
	return putAsset(webStream(res.body), {
		contentType: type.startsWith("video/") ? type : "video/mp4",
		name: meta.name,
		kind: "generated",
		source: {generationId: meta.generationId, originalUrl: videoUrl},
	})
}

export function assetUrls(assetId: string) {
	const mediaPath = `/api/media/${assetId}`
	return {assetId, mediaPath, url: `${config.publicUrl}${mediaPath}`}
}

/** Idempotent: one durable asset per generation id. */
export async function ensureDurable(generationId: string, opts: {videoUrl?: string, mock?: boolean} = {}) {
	const existing = await getGenerationRecord(generationId)
	if (existing?.assetId && await getAsset(existing.assetId)) {
		return {generationId, status: "completed" as const, ...assetUrls(existing.assetId), reused: true}
	}
	let asset: AssetMeta
	if (opts.videoUrl) {
		asset = await downloadToStore(opts.videoUrl, {generationId, name: `reel-${generationId}.mp4`})
		await saveGenerationRecord(generationId, {status: "completed", videoUrl: opts.videoUrl, assetId: asset.assetId})
	} else {
		const g = await resolveGeneration(generationId, {mock: opts.mock})
		if (g.status === "failed") throw new ApiError(409, "generation_failed", g.error ?? "The generation failed.")
		if (g.status !== "completed" || !g.videoUrl) throw new ApiError(409, "not_completed", `The generation is still ${g.status}.`)
		if (g.mock) {
			asset = await putAsset(fs.createReadStream(config.mockSample), {contentType: "video/mp4", name: "mock-generation.mp4", kind: "generated", source: {generationId, originalUrl: "mock"}})
		} else {
			asset = await downloadToStore(g.videoUrl, {generationId, name: `higgsfield-${generationId}.mp4`})
		}
		await saveGenerationRecord(generationId, {assetId: asset.assetId})
	}
	return {generationId, status: "completed" as const, ...assetUrls(asset.assetId), reused: false}
}