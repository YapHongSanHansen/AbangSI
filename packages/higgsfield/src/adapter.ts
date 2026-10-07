/**
 * Adapter: normalises whatever the Higgsfield integration hands us into one small shape the
 * editor/site can rely on. It intentionally tolerates several response formats so that the
 * teammate's integration does not have to change:
 *
 *  - v2 request status   { status, request_id, video: {url}, images: [{url}], error }
 *  - webhook envelope    { request_id, status, error, payload: { video: {url, content_type} } }
 *  - v1 job-set          { id, jobs: [{ id, status, results: { raw: {url,type}, min: {url} } }] }
 *  - camelCase / custom  { generationId | requestId | id, videoUrl | video_url | videos[0].url | output... }
 *  - `{ data: {...} }` / `{ result: {...} }` envelopes and `{ detail }` HTTP error bodies
 */

export type GenerationStatus = "queued" | "processing" | "completed" | "failed"

export interface AdaptedGeneration {
	generationId: string
	status: GenerationStatus
	videoUrl?: string
	thumbnailUrl?: string
	error?: string
	/** provider status string before normalisation (e.g. "in_progress", "nsfw") */
	rawStatus?: string
	raw: unknown
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)
const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v.trim())

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i

const QUEUED = new Set(["queued", "queue", "pending", "created", "submitted", "waiting", "scheduled", "accepted", "new"])
const PROCESSING = new Set(["in_progress", "inprogress", "in-progress", "processing", "running", "started", "generating", "rendering", "active"])
const COMPLETED = new Set(["completed", "complete", "succeeded", "success", "successful", "done", "finished", "ready"])
const FAILED = new Set(["failed", "failure", "error", "errored", "nsfw", "canceled", "cancelled", "rejected", "timeout", "timed_out", "expired", "moderated", "blocked"])

export function normaliseStatus(raw: string | undefined): GenerationStatus | undefined {
	if (!raw) return undefined
	const s = raw.toLowerCase().replace(/\s+/g, "_")
	if (QUEUED.has(s)) return "queued"
	if (PROCESSING.has(s)) return "processing"
	if (COMPLETED.has(s)) return "completed"
	if (FAILED.has(s)) return "failed"
	return undefined
}

function failureMessage(rawStatus: string | undefined, error: string | undefined): string {
	if (error) return error
	switch ((rawStatus ?? "").toLowerCase()) {
		case "nsfw":
		case "moderated":
		case "blocked":
			return "Generation was rejected by content moderation (nsfw). No credits are charged for moderated requests."
		case "canceled":
		case "cancelled":
			return "Generation was canceled."
		case "timeout":
		case "timed_out":
			return "Generation timed out."
		case "expired":
			return "Generation result expired."
		default:
			return "Generation failed."
	}
}

/** url from `"https://..."` | `{url}` | `{uri}` | `{href}` | `{raw:{url}}` */
function urlOf(v: unknown): string | undefined {
	if (isHttpUrl(v)) return v.trim()
	if (isObj(v)) {
		for (const k of ["url", "uri", "href", "src", "download_url", "downloadUrl", "signed_url", "signedUrl"]) {
			if (isHttpUrl(v[k])) return (v[k] as string).trim()
		}
		if (isObj(v.raw)) return urlOf(v.raw)
	}
	return undefined
}

function firstUrl(list: unknown): string | undefined {
	if (!Array.isArray(list)) return urlOf(list)
	for (const item of list) {
		const u = urlOf(item)
		if (u) return u
	}
	return undefined
}

function errorText(v: unknown): string | undefined {
	if (str(v)) return str(v)
	if (isObj(v)) return str(v.message) ?? str(v.detail) ?? str(v.error) ?? str(v.reason)
	if (Array.isArray(v) && v.length) return v.map(e => errorText(e) ?? JSON.stringify(e)).join("; ")
	return undefined
}

/** Last-resort: depth-limited search for an http(s) URL that looks like a video file. */
function deepFindVideoUrl(v: unknown, depth = 0, seen = new Set<unknown>()): string | undefined {
	if (depth > 6 || seen.has(v)) return undefined
	if (isHttpUrl(v)) return VIDEO_EXT.test(v) ? v.trim() : undefined
	if (typeof v !== "object" || v === null) return undefined
	seen.add(v)
	const values = Array.isArray(v) ? v : Object.values(v)
	for (const child of values) {
		const found = deepFindVideoUrl(child, depth + 1, seen)
		if (found) return found
	}
	return undefined
}

/** Unwrap common envelopes: { data: {...} }, { result: {...} }, { generation: {...} } */
function unwrap(raw: Obj): Obj {
	let cur = raw
	for (let i = 0; i < 3; i++) {
		const hasOwnSignal = "status" in cur || "request_id" in cur || "jobs" in cur || "video" in cur
		if (hasOwnSignal) break
		const inner = [cur.data, cur.generation, cur.result].find(isObj)
		if (!inner) break
		cur = inner
	}
	return cur
}

interface Pieces {
	id?: string
	rawStatus?: string
	videoUrl?: string
	thumbnailUrl?: string
	error?: string
}

function fromJobs(jobs: unknown[]): Pieces {
	const parsed = jobs.filter(isObj).map(job => {
		const results = isObj(job.results) ? job.results : isObj(job.result) ? job.result : undefined
		const rawUrl = results ? urlOf(results.raw) ?? urlOf(results) : undefined
		const rawType = results && isObj(results.raw) ? str(results.raw.type) : undefined
		const minUrl = results ? urlOf(results.min) ?? urlOf(results.thumbnail) : undefined
		const looksVideo = rawType === "video" || (rawUrl !== undefined && (VIDEO_EXT.test(rawUrl) || !IMAGE_EXT.test(rawUrl)))
		return {
			id: str(job.id),
			rawStatus: str(job.status),
			status: normaliseStatus(str(job.status)),
			videoUrl: looksVideo ? rawUrl : undefined,
			thumbnailUrl: minUrl && minUrl !== rawUrl ? minUrl : undefined,
			error: errorText(job.error),
		}
	})
	if (parsed.length === 0) return {}
	const failed = parsed.find(j => j.status === "failed")
	const done = parsed.find(j => j.status === "completed" && j.videoUrl)
	const all = (s: GenerationStatus) => parsed.every(j => j.status === s)
	let rawStatus: string | undefined
	if (done) rawStatus = "completed"
	else if (failed) rawStatus = failed.rawStatus
	else if (parsed.some(j => j.status === "processing")) rawStatus = "in_progress"
	else if (all("completed")) rawStatus = "completed"
	else rawStatus = parsed[0].rawStatus ?? "queued"
	return {
		rawStatus,
		videoUrl: done?.videoUrl,
		thumbnailUrl: done?.thumbnailUrl ?? parsed.find(j => j.thumbnailUrl)?.thumbnailUrl,
		error: failed?.error,
	}
}

export function adaptHiggsfieldResponse(raw: unknown, fallbackGenerationId = ""): AdaptedGeneration {
	let input: unknown = raw
	if (typeof input === "string") {
		try { input = JSON.parse(input) } catch { /* keep as string */ }
	}
	if (!isObj(input)) {
		return {generationId: fallbackGenerationId, status: "failed", error: "Unrecognised Higgsfield response (not a JSON object).", raw}
	}

	const top = input
	const o = unwrap(top)
	const payload = isObj(o.payload) ? o.payload : isObj(o.output) ? o.output : isObj(o.outputs) ? o.outputs : undefined

	const pieces: Pieces = {
		id: str(o.request_id) ?? str(o.requestId) ?? str(o.generation_id) ?? str(o.generationId) ?? str(o.job_set_id) ?? str(o.jobSetId) ?? str(o.id)
			?? str(top.request_id) ?? str(top.generationId) ?? str(top.id),
		rawStatus: str(o.status) ?? str(o.state) ?? (isObj(o.status) ? str((o.status as Obj).name) : undefined),
		error: errorText(o.error) ?? errorText(o.errors) ?? errorText(o.failure_reason) ?? errorText(o.failureReason),
	}

	// video url candidates, most specific first
	const sources: Obj[] = [o, ...(payload ? [payload] : [])]
	for (const src of sources) {
		pieces.videoUrl ??= urlOf(src.video) ?? firstUrl(src.videos) ?? urlOf(src.video_url) ?? urlOf(src.videoUrl)
			?? urlOf(src.output_url) ?? urlOf(src.outputUrl) ?? urlOf(src.result_url) ?? urlOf(src.resultUrl)
		pieces.thumbnailUrl ??= urlOf(src.thumbnail) ?? urlOf(src.thumbnail_url) ?? urlOf(src.thumbnailUrl)
			?? urlOf(src.poster) ?? urlOf(src.poster_url) ?? urlOf(src.cover) ?? urlOf(src.preview)
	}

	if (Array.isArray(o.jobs)) {
		const j = fromJobs(o.jobs)
		pieces.rawStatus ??= j.rawStatus
		if (!str(o.status)) pieces.rawStatus = j.rawStatus
		pieces.videoUrl ??= j.videoUrl
		pieces.thumbnailUrl ??= j.thumbnailUrl
		pieces.error ??= j.error
	}

	// images[] alongside a video are thumbnails; images-only output is not a video
	if (!pieces.thumbnailUrl && pieces.videoUrl) pieces.thumbnailUrl = firstUrl(o.images) ?? (payload ? firstUrl(payload.images) : undefined)

	// legacy "url" at the top level, only when it is clearly a video file
	if (!pieces.videoUrl && isHttpUrl(o.url) && VIDEO_EXT.test(o.url)) pieces.videoUrl = (o.url as string).trim()

	let status = normaliseStatus(pieces.rawStatus)
	// bare HTTP error body, e.g. {"detail":"Not found"}
	if (!status && !pieces.videoUrl && str(top.detail)) {
		return {generationId: pieces.id ?? fallbackGenerationId, status: "failed", error: str(top.detail), rawStatus: pieces.rawStatus, raw}
	}
	if (!pieces.videoUrl && (status === "completed" || status === undefined)) {
		pieces.videoUrl = deepFindVideoUrl(o)
	}
	if (!status) status = pieces.videoUrl ? "completed" : "queued"

	const result: AdaptedGeneration = {generationId: pieces.id ?? fallbackGenerationId, status, raw}
	if (pieces.rawStatus) result.rawStatus = pieces.rawStatus

	if (status === "completed") {
		if (!pieces.videoUrl) {
			result.status = "failed"
			result.error = "Higgsfield reported the generation as completed but no video URL was found in the response."
		} else {
			result.videoUrl = pieces.videoUrl
			if (pieces.thumbnailUrl && pieces.thumbnailUrl !== pieces.videoUrl) result.thumbnailUrl = pieces.thumbnailUrl
		}
	} else if (status === "failed") {
		result.error = failureMessage(pieces.rawStatus, pieces.error)
	}
	return result
}

export const isTerminal = (g: Pick<AdaptedGeneration, "status">) => g.status === "completed" || g.status === "failed"