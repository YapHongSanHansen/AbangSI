/**
 * Tiny file-backed store (no DB needed for the demo):
 *   media-store/blobs/<sha256>            immutable media bytes (content addressed; sha256 == Omniclip file hash)
 *   media-store/blobs/<sha256>.json       metadata (content type, size, provenance)
 *   media-store/generations/<id>.json     generation record (latest adapted status, durable asset id, webhook events)
 *   media-store/projects/<id>.json        saved editor projects
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import {pipeline} from "node:stream/promises"
import {Readable, Transform} from "node:stream"

import {config} from "./config.ts"
import {ApiError} from "./errors.ts"

export interface AssetMeta {
	assetId: string
	size: number
	contentType: string
	name?: string
	kind: "generated" | "upload" | "export"
	source?: {generationId?: string, originalUrl?: string, projectId?: string}
	createdAt: string
}

export interface GenerationRecord {
	generationId: string
	status?: string
	videoUrl?: string
	thumbnailUrl?: string
	error?: string
	assetId?: string
	prompt?: string
	model?: string
	createdAt: string
	updatedAt: string
	webhookEvents?: {status: string, at: string}[]
}

const dirs = {
	blobs: path.join(config.mediaDir, "blobs"),
	tmp: path.join(config.mediaDir, "tmp"),
	generations: path.join(config.mediaDir, "generations"),
	projects: path.join(config.mediaDir, "projects"),
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, {recursive: true})

export const isAssetId = (id: string) => /^[a-f0-9]{64}$/.test(id)
const safeId = (id: string) => {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || id.includes("..")) throw new ApiError(400, "bad_id", "Invalid id.")
	return id
}

async function readJson<T>(file: string): Promise<T | null> {
	try { return JSON.parse(await fsp.readFile(file, "utf8")) as T } catch { return null }
}
async function writeJson(file: string, data: unknown) {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await fsp.writeFile(tmp, JSON.stringify(data, null, 2))
	await fsp.rename(tmp, file)
}

export const blobPath = (assetId: string) => path.join(dirs.blobs, assetId)

export async function getAsset(assetId: string): Promise<AssetMeta | null> {
	if (!isAssetId(assetId)) return null
	if (!fs.existsSync(blobPath(assetId))) return null
	return readJson<AssetMeta>(`${blobPath(assetId)}.json`)
}

/** Streams bytes into the content-addressed store. Never overwrites an existing blob (originals stay intact). */
export async function putAsset(body: Readable | AsyncIterable<Uint8Array>, meta: Omit<AssetMeta, "assetId" | "size" | "createdAt">, maxBytes = config.maxDownloadBytes): Promise<AssetMeta> {
	const tmp = path.join(dirs.tmp, crypto.randomUUID())
	const hash = crypto.createHash("sha256")
	let size = 0
	const meter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			size += chunk.length
			if (size > maxBytes) return cb(new ApiError(413, "too_large", `Media is larger than ${maxBytes} bytes.`))
			hash.update(chunk)
			cb(null, chunk)
		},
	})
	try {
		await pipeline(body as Readable, meter, fs.createWriteStream(tmp))
	} catch (e) {
		await fsp.rm(tmp, {force: true})
		throw e
	}
	if (size === 0) {
		await fsp.rm(tmp, {force: true})
		throw new ApiError(422, "empty_media", "The media file is empty.")
	}
	const assetId = hash.digest("hex")
	const dest = blobPath(assetId)
	if (fs.existsSync(dest)) {
		await fsp.rm(tmp, {force: true})
		const existing = await getAsset(assetId)
		if (existing) return existing
	} else {
		await fsp.rename(tmp, dest)
	}
	const full: AssetMeta = {...meta, assetId, size, createdAt: new Date().toISOString()}
	await writeJson(`${dest}.json`, full)
	return full
}

export async function getGenerationRecord(id: string) {
	return readJson<GenerationRecord>(path.join(dirs.generations, `${safeId(id)}.json`))
}
export async function saveGenerationRecord(id: string, patch: Partial<GenerationRecord>) {
	const file = path.join(dirs.generations, `${safeId(id)}.json`)
	const now = new Date().toISOString()
	const current = (await readJson<GenerationRecord>(file)) ?? {generationId: id, createdAt: now, updatedAt: now}
	const next: GenerationRecord = {...current, ...patch, generationId: id, updatedAt: now}
	await writeJson(file, next)
	return next
}

export interface SavedProject {
	projectId: string
	name?: string
	state: unknown
	settings?: unknown
	imports?: Record<string, {hash: string, effectId: string, mode: string, at: number}>
	media: {hash: string, name?: string, type?: string, kind?: string}[]
	generationIds?: string[]
	updatedAt: string
	createdAt: string
}

export async function getProject(projectId: string) {
	return readJson<SavedProject>(path.join(dirs.projects, `${safeId(projectId)}.json`))
}
export async function saveProject(project: Omit<SavedProject, "updatedAt" | "createdAt">) {
	const file = path.join(dirs.projects, `${safeId(project.projectId)}.json`)
	const existing = await readJson<SavedProject>(file)
	const now = new Date().toISOString()
	const saved: SavedProject = {...project, createdAt: existing?.createdAt ?? now, updatedAt: now}
	await writeJson(file, saved)
	return saved
}
export async function listProjects() {
	const files = (await fsp.readdir(dirs.projects)).filter(f => f.endsWith(".json"))
	const out = []
	for (const f of files) {
		const p = await readJson<SavedProject>(path.join(dirs.projects, f))
		if (p) out.push({projectId: p.projectId, name: p.name, updatedAt: p.updatedAt, media: p.media.length, generationIds: p.generationIds ?? []})
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function webStream(body: ReadableStream<Uint8Array>) {
	return Readable.fromWeb(body as any)
}