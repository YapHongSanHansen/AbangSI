/**
 * Small registry of Higgsfield video model endpoints we know the input schema of
 * (from https://docs.higgsfield.ai model pages / openapi.json, checked 2026-10-07).
 * Prices are from the free POST /estimate/<model> endpoint for this account on that date.
 * Unknown model ids are still accepted and sent with a generic body.
 */
export type AspectRatio = "9:16" | "16:9" | "1:1"

export interface VideoModelSpec {
	id: string
	kind: "text-to-video" | "image-to-video"
	/** discrete allowed durations (seconds) ... */
	durations?: number[]
	/** ... or an inclusive range */
	durationRange?: [number, number]
	defaultDuration: number
	aspectRatios?: string[]
	imageField?: string
	/** fixed extra input fields sent with every request */
	defaults?: Record<string, unknown>
	note?: string
}

export const VIDEO_MODELS: Record<string, VideoModelSpec> = {
	"bytedance/seedance-2.5/text-to-video": {
		id: "bytedance/seedance-2.5/text-to-video",
		kind: "text-to-video",
		durationRange: [4, 30],
		defaultDuration: 5,
		aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
		defaults: {resolution: "720p", output_format: "mp4", generate_audio: true},
		note: "ReelForge default: supports aspect_ratio (9:16 reels), 480p/720p/1080p, 4-30s, mp4 output",
	},
	"minimax/hailuo-2.3/standard/text-to-video": {
		id: "minimax/hailuo-2.3/standard/text-to-video",
		kind: "text-to-video",
		durations: [6, 10],
		defaultDuration: 6,
		note: "cheapest text-to-video found: ~3.8 credits (~$0.24) for 6s; no aspect ratio parameter",
	},
	"minimax/hailuo-2.3/standard/image-to-video": {
		id: "minimax/hailuo-2.3/standard/image-to-video",
		kind: "image-to-video",
		durations: [6, 10],
		defaultDuration: 6,
		imageField: "image_url",
	},
	"kling-video/v2.5-turbo/standard/image-to-video": {
		id: "kling-video/v2.5-turbo/standard/image-to-video",
		kind: "image-to-video",
		durations: [5, 10],
		defaultDuration: 5,
		imageField: "image_url",
		note: "cheapest image-to-video found: ~2.9 credits (~$0.18) for 5s",
	},
	"kling-video/v2.5-turbo/pro/text-to-video": {
		id: "kling-video/v2.5-turbo/pro/text-to-video",
		kind: "text-to-video",
		durations: [5, 10],
		defaultDuration: 5,
	},
	"lightricks/ltx-2.5/text-to-video/fast": {
		id: "lightricks/ltx-2.5/text-to-video/fast",
		kind: "text-to-video",
		durations: [6, 8, 10],
		defaultDuration: 6,
		aspectRatios: ["16:9", "9:16"],
		note: "~8.6 credits (~$0.54) for 6s 720p; supports aspect_ratio",
	},
}

export const DEFAULT_TEXT_TO_VIDEO_MODEL = "bytedance/seedance-2.5/text-to-video"
export const CHEAPEST_TEXT_TO_VIDEO_MODEL = "minimax/hailuo-2.3/standard/text-to-video"
export const DEFAULT_IMAGE_TO_VIDEO_MODEL = "kling-video/v2.5-turbo/standard/image-to-video"

function closest(values: number[], wanted: number) {
	return values.reduce((best, v) => (Math.abs(v - wanted) < Math.abs(best - wanted) ? v : best), values[0])
}

export interface CreateInput {
	prompt: string
	durationSeconds?: number
	aspectRatio?: AspectRatio
	imageUrl?: string
}

/** Build the JSON body for a model, only sending fields that model accepts. */
export function buildModelInput(modelId: string, input: CreateInput, extra?: Record<string, unknown>): Record<string, unknown> {
	const spec = VIDEO_MODELS[modelId]
	const body: Record<string, unknown> = {prompt: input.prompt}
	if (!spec) {
		if (input.durationSeconds) body.duration = input.durationSeconds
		if (input.aspectRatio) body.aspect_ratio = input.aspectRatio
		if (input.imageUrl) body.image_url = input.imageUrl
		return {...body, ...extra}
	}
	const wanted = input.durationSeconds ?? spec.defaultDuration
	body.duration = spec.durations
		? closest(spec.durations, wanted)
		: spec.durationRange
			? Math.min(spec.durationRange[1], Math.max(spec.durationRange[0], Math.round(wanted)))
			: wanted
	if (spec.defaults) Object.assign(body, spec.defaults)
	if (spec.aspectRatios && input.aspectRatio && spec.aspectRatios.includes(input.aspectRatio)) body.aspect_ratio = input.aspectRatio
	if (spec.kind === "image-to-video") {
		if (!input.imageUrl) throw new Error(`Model ${modelId} requires imageUrl`)
		body[spec.imageField ?? "image_url"] = input.imageUrl
	}
	return {...body, ...extra}
}

export function pickModel(model: string | undefined, imageUrl: string | undefined) {
	if (model && model !== "default") return model.replace(/^\/+/, "")
	return imageUrl ? DEFAULT_IMAGE_TO_VIDEO_MODEL : DEFAULT_TEXT_TO_VIDEO_MODEL
}