/**
 * Server-only Higgsfield client (https://docs.higgsfield.ai), built on the official SDK
 * `@higgsfield/client/v2` for submissions.
 *
 *   Auth:    Authorization: Key <keyId>:<secret>   (HF_CREDENTIALS or HIGGSFIELD_API_KEY, or opts.apiKey)
 *   Create:  POST {base}/{model-id}[?hf_webhook=<https url>]  -> SDK higgsfield.subscribe(model, {input, withPolling:false})
 *   Status:  GET  {base}/requests/{request_id}/status         -> raw fetch (the SDK has no non-blocking status call)
 *   Cancel:  POST {base}/requests/{request_id}/cancel         -> raw fetch
 *   Price:   POST {base}/estimate/{model-id}                  -> raw fetch (free, no generation)
 *
 * base = HIGGSFIELD_BASE_URL or https://api.higgsfield.ai (SDK default; https://platform.higgsfield.ai answers too).
 * NEVER import this from browser code. Errors are re-wrapped so no request config (headers) is ever attached.
 */
import {randomUUID} from "node:crypto"
import {config as sdkConfig, higgsfield} from "@higgsfield/client/v2"

import {adaptHiggsfieldResponse, isTerminal, type AdaptedGeneration} from "./adapter.ts"
import {buildModelInput, pickModel, type AspectRatio} from "./models.ts"

export const DEFAULT_BASE_URL = "https://api.higgsfield.ai"
/** CC0 sample clip (MDN interactive examples), served with Access-Control-Allow-Origin: * */
export const DEFAULT_MOCK_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"

export class HiggsfieldError extends Error {
	code: string
	httpStatus?: number
	detail?: unknown
	constructor(message: string, code: string, httpStatus?: number, detail?: unknown) {
		super(message)
		this.name = "HiggsfieldError"
		this.code = code
		this.httpStatus = httpStatus
		this.detail = detail
	}
}

export interface ClientOptions {
	apiKey?: string
	baseUrl?: string
	timeoutMs?: number
}

export interface CreateVideoOptions extends ClientOptions {
	prompt: string
	durationSeconds?: number
	aspectRatio?: AspectRatio
	imageUrl?: string
	/** Higgsfield model id (default "bytedance/seedance-2.5/text-to-video") or "mock" */
	model?: string
	/** public HTTPS URL that Higgsfield will POST the terminal result to */
	webhookUrl?: string
	idempotencyKey?: string
	/** additional model-specific input fields */
	extraInput?: Record<string, unknown>
}

const env = (k: string) => (typeof process !== "undefined" ? process.env[k] : undefined)

export function isMockMode(model?: string) {
	return model === "mock" || env("VIDEO_BACKEND") === "mock"
}
export const isMockId = (id: string) => id.startsWith("mock-")
export const mockVideoUrl = () => env("HIGGSFIELD_MOCK_VIDEO_URL") || DEFAULT_MOCK_VIDEO_URL

function baseUrl(opts?: ClientOptions) {
	return (opts?.baseUrl || env("HIGGSFIELD_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "")
}

function credentials(opts?: ClientOptions): string {
	if (typeof window !== "undefined") throw new HiggsfieldError("The Higgsfield client is server-only.", "browser_not_supported")
	const key = (opts?.apiKey ?? env("HF_CREDENTIALS") ?? env("HIGGSFIELD_API_KEY") ?? "").trim()
	if (!key) throw new HiggsfieldError("Higgsfield credentials are not set (HF_CREDENTIALS or HIGGSFIELD_API_KEY).", "missing_credentials")
	if (!/^[^:\s]+:[^:\s]+$/.test(key)) throw new HiggsfieldError("Higgsfield credentials must have the form <keyId>:<secret>.", "bad_credentials_format")
	return key
}

function codeForStatus(status: number | undefined) {
	if (status === undefined) return "network_error"
	return status === 401 ? "unauthorized" :
		status === 402 || status === 403 ? "not_enough_credits_or_forbidden" :
		status === 404 ? "not_found" :
		status === 400 || status === 422 ? "bad_input" :
		status === 429 ? "rate_limited" :
		status >= 500 ? "upstream_error" : "http_error"
}

/** Convert SDK/axios errors into HiggsfieldError WITHOUT carrying the request config (it holds the auth header). */
function fromSdkError(e: unknown): HiggsfieldError {
	if (e instanceof HiggsfieldError) return e
	const err = e as {name?: string, message?: string, statusCode?: number, response?: {status?: number, data?: {detail?: unknown}}, code?: string}
	const status = err?.statusCode ?? err?.response?.status
	const name = err?.name ?? "Error"
	if (name === "AuthenticationError") return new HiggsfieldError("Invalid Higgsfield credentials.", "unauthorized", 401)
	if (name === "CredentialsMissedError") return new HiggsfieldError("Higgsfield credentials are not set.", "missing_credentials")
	if (name === "TimeoutError") return new HiggsfieldError(err.message ?? "Timed out.", "timeout")
	const detail = err?.response?.data?.detail
	const message = typeof detail === "string" ? detail : (name === "AxiosError" ? `Higgsfield request failed (${err.code ?? status ?? "network"})` : err?.message ?? "Higgsfield request failed")
	return new HiggsfieldError(message, codeForStatus(status), status, typeof detail === "string" ? detail : undefined)
}

async function request(method: "GET" | "POST", path: string, opts: ClientOptions & {body?: unknown}) {
	let res: Response
	try {
		res = await fetch(`${baseUrl(opts)}${path}`, {
			method,
			headers: {
				Authorization: `Key ${credentials(opts)}`,
				Accept: "application/json",
				...(opts.body !== undefined ? {"Content-Type": "application/json"} : {}),
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
		})
	} catch (e) {
		if (e instanceof HiggsfieldError) throw e
		throw new HiggsfieldError(`Could not reach Higgsfield (${(e as Error).name}).`, "network_error")
	}
	const text = await res.text()
	let data: unknown = text
	try { data = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
	if (!res.ok) {
		const detail = typeof data === "object" && data && "detail" in data ? (data as {detail: unknown}).detail : data
		throw new HiggsfieldError(typeof detail === "string" ? detail : `Higgsfield HTTP ${res.status}`, codeForStatus(res.status), res.status, detail)
	}
	return data
}

function mockCompleted(generationId: string): AdaptedGeneration {
	return adaptHiggsfieldResponse({status: "completed", request_id: generationId, video: {url: mockVideoUrl()}, mock: true}, generationId)
}

export async function createVideo(opts: CreateVideoOptions): Promise<{generationId: string, raw: unknown}> {
	if (!opts?.prompt || opts.prompt.trim().length < 1) throw new HiggsfieldError("prompt is required.", "bad_input")
	if (isMockMode(opts.model)) {
		const generationId = `mock-${randomUUID()}`
		return {generationId, raw: {status: "completed", request_id: generationId, video: {url: mockVideoUrl()}, mock: true}}
	}
	const model = pickModel(opts.model, opts.imageUrl)
	const input = buildModelInput(model, opts, opts.extraInput)
	let raw: unknown
	try {
		// configure + subscribe in the same tick: the SDK reads its (module-level) client synchronously
		sdkConfig({
			credentials: credentials(opts),
			baseURL: baseUrl(opts),
			timeout: opts.timeoutMs ?? 60_000,
			maxRetries: 2,
			// the SDK retries on 5xx/timeouts; the idempotency key keeps a retry from creating a second paid job
			headers: {"Idempotency-Key": opts.idempotencyKey ?? randomUUID()},
		} as any)
		raw = await higgsfield.subscribe(model, {
			input,
			withPolling: false,
			...(opts.webhookUrl ? {webhook: {url: opts.webhookUrl, secret: ""}} : {}),
		} as any)
	} catch (e) {
		throw fromSdkError(e)
	}
	const adapted = adaptHiggsfieldResponse(raw)
	if (!adapted.generationId) throw new HiggsfieldError("Higgsfield accepted the request but returned no request_id.", "bad_response", undefined, raw)
	return {generationId: adapted.generationId, raw}
}

export async function getGeneration(generationId: string, opts?: ClientOptions & {model?: string}): Promise<AdaptedGeneration> {
	if (!generationId) throw new HiggsfieldError("generationId is required.", "bad_input")
	if (isMockId(generationId) || isMockMode(opts?.model)) return mockCompleted(generationId)
	const raw = await request("GET", `/requests/${encodeURIComponent(generationId)}/status`, {...opts})
	return adaptHiggsfieldResponse(raw, generationId)
}

export async function cancelGeneration(generationId: string, opts?: ClientOptions): Promise<void> {
	if (isMockId(generationId)) return
	await request("POST", `/requests/${encodeURIComponent(generationId)}/cancel`, {...opts})
}

/** Free price check, does not start a generation. */
export async function estimateVideo(opts: CreateVideoOptions): Promise<{credits?: string, usd?: string, raw: unknown}> {
	if (isMockMode(opts.model)) return {credits: "0", usd: "0", raw: {mock: true}}
	const model = pickModel(opts.model, opts.imageUrl)
	const raw = await request("POST", `/estimate/${model}`, {...opts, body: buildModelInput(model, opts, opts.extraInput)}) as {credits?: string, usd?: string}
	return {credits: raw?.credits, usd: raw?.usd, raw}
}

export interface WaitOptions extends ClientOptions {
	timeoutMs?: number
	pollMs?: number
	model?: string
	onUpdate?: (g: AdaptedGeneration) => void
	signal?: AbortSignal
}

/** Polls until the generation is completed or failed. Throws HiggsfieldError("timeout") on timeout. */
export async function waitForVideo(generationId: string, opts: WaitOptions = {}): Promise<AdaptedGeneration> {
	const timeoutMs = opts.timeoutMs ?? 10 * 60_000
	const pollMs = Math.max(500, opts.pollMs ?? 3_000)
	const deadline = Date.now() + timeoutMs
	const requestOpts: ClientOptions & {model?: string} = {apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, timeoutMs: 30_000}
	for (;;) {
		if (opts.signal?.aborted) throw new HiggsfieldError("Aborted.", "aborted")
		try {
			const g = await getGeneration(generationId, requestOpts)
			opts.onUpdate?.(g)
			if (isTerminal(g)) return g
		} catch (e) {
			const err = e as HiggsfieldError
			const transient = err.code === "network_error" || err.code === "upstream_error" || err.code === "rate_limited"
			if (!transient) throw e
		}
		if (Date.now() + pollMs > deadline) throw new HiggsfieldError(`Generation ${generationId} did not finish within ${timeoutMs} ms.`, "timeout")
		await new Promise(r => setTimeout(r, pollMs))
	}
}