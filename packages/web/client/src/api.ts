export type GenerationStatus = "queued" | "processing" | "completed" | "failed"

export interface Generation {
	generationId: string
	status: GenerationStatus
	videoUrl?: string
	thumbnailUrl?: string
	error?: string
	mock?: boolean
	durable?: DurableAsset
}

export interface DurableAsset {
	assetId: string
	mediaPath: string
	url: string
}

export class ApiFailure extends Error {
	constructor(public status: number, public code: string, message: string, public details?: unknown) {
		super(message)
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response
	try {
		res = await fetch(path, init)
	} catch {
		throw new ApiFailure(0, "network", "Cannot reach the ReelForge server. Is it running?")
	}
	const body = await res.json().catch(() => null)
	if (!res.ok) {
		const err = body?.error ?? {}
		throw new ApiFailure(res.status, err.code ?? "http_error", err.message ?? `Request failed (HTTP ${res.status})`, err.details)
	}
	return body as T
}

const json = (data: unknown): RequestInit => ({method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)})

export const api = {
	health: () => call<{ok: boolean, higgsfieldConfigured: boolean, videoBackend: string}>("/api/health"),
	createGeneration: (input: {prompt: string, aspectRatio?: string, durationSeconds?: number, mock?: boolean}) =>
		call<{generationId: string, mock: boolean}>("/api/generations", json(input)),
	getGeneration: (id: string, mock = false) => call<Generation>(`/api/generations/${encodeURIComponent(id)}${mock ? "?mock=1" : ""}`),
	durable: (id: string, mock = false) =>
		call<DurableAsset & {generationId: string}>(`/api/generations/${encodeURIComponent(id)}/durable${mock ? "?mock=1" : ""}`, {method: "POST"}),
	importFromUrl: (generationId: string, videoUrl?: string, mock = false) =>
		call<DurableAsset & {generationId: string}>("/api/imports", json({generationId, videoUrl, mock})),
	checkMedia: (hashes: string[]) => call<{present: string[]}>("/api/media/check", json({hashes})),
	uploadMedia: (bytes: ArrayBuffer | Blob, type: string, name: string, opts: {kind?: "export" | "upload", projectId?: string} = {}) => {
		const q = new URLSearchParams()
		if (opts.kind) q.set("kind", opts.kind)
		if (opts.projectId) q.set("projectId", opts.projectId)
		return call<DurableAsset & {size: number}>(`/api/media?${q}`, {method: "POST", headers: {"Content-Type": type, "X-File-Name": name}, body: bytes})
	},
	getProject: (id: string) => call<SavedProject>(`/api/projects/${encodeURIComponent(id)}`),
	saveProject: (id: string, project: Omit<SavedProject, "projectId" | "updatedAt">) => call<{ok: true, updatedAt: string}>(`/api/projects/${encodeURIComponent(id)}`, json(project)),
	listProjects: () => call<{projects: {projectId: string, name?: string, updatedAt: string, media: number, generationIds: string[]}[]}>("/api/projects"),
}

export interface SavedProject {
	projectId: string
	name?: string
	state: unknown
	settings?: unknown
	imports?: Record<string, unknown>
	media: {hash: string, name?: string, type?: string, kind?: string, url?: string, mediaPath?: string}[]
	generationIds?: string[]
	updatedAt?: string
}

export const projectIdFor = (generationId: string) => `reel-${generationId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "untitled"}`

/** Polls a generation until it is terminal. */
export async function pollGeneration(id: string, opts: {mock?: boolean, onUpdate?: (g: Generation) => void, signal?: AbortSignal, intervalMs?: number} = {}) {
	for (;;) {
		if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
		const g = await api.getGeneration(id, opts.mock)
		opts.onUpdate?.(g)
		if (g.status === "completed" || g.status === "failed") return g
		await new Promise(r => setTimeout(r, opts.intervalMs ?? 2500))
	}
}