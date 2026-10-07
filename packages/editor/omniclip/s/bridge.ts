/**
 * ReelForge bridge (custom, not part of upstream Omniclip).
 *
 * Hands a completed Higgsfield generation to the editor and reports results back to the host page.
 *
 * URL params (put them BEFORE the hash):  /?src=<durable mp4 url>&gen=<generationId>#/editor/<projectId>
 *   -> imports the MP4 into the media library AND places it on the timeline, once per project+generation.
 *
 * postMessage protocol (parent <-> editor iframe, origins checked against an allowlist):
 *   editor -> parent  reelforge:ready      {projectId, hasLocalProject, imports, effects}
 *   parent -> editor  reelforge:init       {project?: SavedProject}   (restore a server-saved project when local storage is empty)
 *   parent -> editor  reelforge:import     {url? | buffer?, generationId, mode: "append" | "replace" | "auto", name?}
 *   editor -> parent  reelforge:imported   {generationId, mode, hash, effectId, durationMs, skipped?}
 *   parent -> editor  reelforge:export     {}            (starts an export, same as the Export button)
 *   editor -> parent  reelforge:exported   {buffer (transferred), size, durationMs, projectId}
 *   parent -> editor  reelforge:snapshot-request {knownHashes: string[]}
 *   editor -> parent  reelforge:snapshot   {projectId, state, settings, imports, media: [{hash, name, type, kind, buffer?}]}
 *   editor -> parent  reelforge:changed    {projectId, effects}
 *   editor -> parent  reelforge:selection  {effectId, kind}
 *   editor -> parent  reelforge:error      {code, message, generationId?, request?}
 */
import {generate_id} from "@benev/slate"
import {quick_hash} from "@benev/construct"

import {omnislate} from "./context/context.js"
import type {OmniContext} from "./context/context.js"
import type {AnyEffect, HistoricalState, TextEffect, VideoEffect, AspectRatio, Standard} from "./context/types.js"
import type {AnyMedia, VideoFile} from "./components/omni-media/types.js"

interface ReelforgeConfig {
	allowedParentOrigins?: string[]
	allowedMediaOrigins?: string[]
}

declare global {
	interface Window {
		REELFORGE_CONFIG?: ReelforgeConfig
		reelforge?: unknown
	}
}

type ImportMode = "append" | "replace" | "auto"

export interface SavedProject {
	projectId: string
	state: Partial<HistoricalState>
	settings?: Record<string, unknown>
	imports?: Record<string, ImportRecord>
	media: {hash: string, url: string, name?: string, type?: string}[]
}

interface ImportRecord {
	hash: string
	effectId: string
	mode: ImportMode
	at: number
}

class BridgeError extends Error {
	constructor(public code: string, message: string) {
		super(message)
	}
}

const config: ReelforgeConfig = window.REELFORGE_CONFIG ?? {}
// same origin is always trusted (single-origin deployment: site at /, editor at /editor/, API at /api)
const allowedParentOrigins = [location.origin, ...(config.allowedParentOrigins ?? ["http://localhost:5173", "http://127.0.0.1:5173"])]
const allowedMediaOrigins = [location.origin, ...(config.allowedMediaOrigins ?? ["http://localhost:3001", "http://127.0.0.1:3001"])]
const embedded = window.parent !== window
const params = new URLSearchParams(location.search)

let parentOrigin: string | null = (() => {
	try {
		const ref = document.referrer ? new URL(document.referrer).origin : null
		return ref && allowedParentOrigins.includes(ref) ? ref : null
	} catch { return null }
})()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function post(message: Record<string, unknown>, transfer: Transferable[] = []) {
	if (!embedded) {
		window.dispatchEvent(new CustomEvent("reelforge", {detail: message}))
		return
	}
	if (parentOrigin) {
		window.parent.postMessage(message, parentOrigin, transfer)
	} else if (transfer.length === 0) {
		for (const origin of allowedParentOrigins) window.parent.postMessage(message, origin)
	} else {
		console.warn("[reelforge] parent origin unknown, cannot transfer", message.type)
	}
}

function postError(e: unknown, extra: Record<string, unknown> = {}) {
	const code = e instanceof BridgeError ? e.code : "unexpected_error"
	const message = e instanceof Error ? e.message : String(e)
	console.error("[reelforge]", code, message)
	post({type: "reelforge:error", code, message, ...extra})
}

function currentProjectId(): string | null {
	const m = /^#\/editor\/([^/?#]+)/.exec(location.hash)
	return m ? decodeURIComponent(m[1]) : null
}

function getContext(): OmniContext | null {
	try {
		const ctx = omnislate.context as OmniContext | undefined
		return ctx && (ctx as any).controllers ? ctx : null
	} catch { return null }
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const v = fn()
		if (v) return v
		if (Date.now() > deadline) throw new BridgeError("timeout", `Timed out waiting for ${what}.`)
		await sleep(100)
	}
}

/** Waits until the editor route created its context, stored media is loaded and the compositor is rebuilt. */
async function readyContext(timeoutMs = 60_000): Promise<OmniContext> {
	const ctx = await waitFor(() => {
		const c = getContext()
		return c && c.state.projectId === currentProjectId() && c.controllers.compositor.recreated ? c : null
	}, timeoutMs, "the editor to load")
	await ctx.controllers.media.are_files_ready()
	return ctx
}

const importsKey = (projectId: string) => `reelforge_imports_${projectId}`
function readImports(projectId: string): Record<string, ImportRecord> {
	try { return JSON.parse(localStorage.getItem(importsKey(projectId)) ?? "{}") } catch { return {} }
}
function writeImports(projectId: string, imports: Record<string, ImportRecord>) {
	localStorage.setItem(importsKey(projectId), JSON.stringify(imports))
}

function checkMediaUrl(url: string): URL {
	let u: URL
	try { u = new URL(url, location.href) } catch { throw new BridgeError("bad_url", "The video URL is not valid.") }
	if (u.protocol === "blob:" || u.protocol === "data:") return u
	if (!allowedMediaOrigins.includes(u.origin)) {
		throw new BridgeError("media_origin_not_allowed", `Refusing to load media from ${u.origin}. Only the ReelForge backend (${allowedMediaOrigins.join(", ")}) may supply media to the editor.`)
	}
	return u
}

async function fetchFile(url: string, name: string, expectKind: "video" | "any" = "video"): Promise<File> {
	const u = checkMediaUrl(url)
	let res: Response
	try {
		res = await fetch(u.href, {mode: "cors", credentials: "omit"})
	} catch {
		throw new BridgeError("media_inaccessible", "The video could not be downloaded in the browser (network error or the server blocks cross-origin access). Ask the backend for a durable copy.")
	}
	if (res.status === 403 || res.status === 404 || res.status === 410) {
		throw new BridgeError("media_expired", `The video URL is no longer available (HTTP ${res.status}). It may have expired.`)
	}
	if (!res.ok) throw new BridgeError("media_http_error", `Downloading the video failed with HTTP ${res.status}.`)
	const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
	const blob = await res.blob()
	if (blob.size === 0) throw new BridgeError("media_empty", "The video file is empty.")
	if (expectKind === "video" && contentType && !contentType.startsWith("video/") && contentType !== "application/octet-stream") {
		throw new BridgeError("not_a_video", `Expected a video but the server returned ${contentType}.`)
	}
	const type = contentType && contentType !== "application/octet-stream" ? contentType : (expectKind === "video" ? "video/mp4" : "application/octet-stream")
	return new File([blob], name, {type})
}

/** Adds the file to Omniclip's media library (IndexedDB) unless the same bytes are already there. */
async function ensureInLibrary(ctx: OmniContext, file: File, hash?: string): Promise<AnyMedia> {
	const media = ctx.controllers.media
	const h = hash ?? await quick_hash(file)
	if (!media.get(h)) {
		try {
			await media.import_file(file, hash)
		} catch (e) {
			throw new BridgeError("import_failed", `Omniclip could not read this file: ${(e as Error).message ?? e}`)
		}
		await waitFor(() => media.get(h), 60_000, "the media library import")
	}
	return media.get(h)!
}

const ASPECTS: [AspectRatio, number][] = [["16/9", 16 / 9], ["9/16", 9 / 16], ["1/1", 1], ["4/3", 4 / 3], ["3/2", 3 / 2], ["21/9", 21 / 9]]
const TIMEBASES = [10, 24, 25, 30, 50, 60, 90, 120]

/** First clip of a fresh project: match canvas size (and fps when standard) to the generated video. */
function fitProjectToVideo(ctx: OmniContext, width: number, height: number, fps: number) {
	const w = width - (width % 2), h = height - (height % 2)
	if (w <= 0 || h <= 0) return
	const ratio = w / h
	const aspect = ASPECTS.reduce((best, cur) => Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best)[0]
	const short = Math.min(w, h)
	const standard: Standard = short >= 2160 ? "4k" : short >= 1440 ? "2k" : short >= 1080 ? "1080p" : short >= 720 ? "720p" : "480p"
	ctx.actions.set_aspect_ratio(aspect, {omit: true})
	ctx.actions.set_standard(standard, {omit: true})
	ctx.actions.set_project_resolution(w, h, {omit: true})
	ctx.controllers.compositor.set_canvas_resolution(w, h)
	const roundedFps = Math.round(fps)
	if (TIMEBASES.includes(roundedFps)) {
		ctx.actions.set_timebase(roundedFps, {omit: true})
		ctx.controllers.compositor.set_timebase(roundedFps)
	}
}

function trackEnd(effects: AnyEffect[], track: number) {
	return effects.filter(e => e.track === track).reduce((max, e) => Math.max(max, e.start_at_position + (e.end - e.start)), 0)
}

function refreshCanvas(ctx: OmniContext) {
	const compositor = ctx.controllers.compositor
	compositor.compose_effects(ctx.state.effects, ctx.state.timecode)
	compositor.seek(ctx.state.timecode, true).then(() => compositor.compose_effects(ctx.state.effects, ctx.state.timecode))
}

/** Puts the video on the timeline. "Main" video track = bottom track; overlays (text) go on track 0 above it. */
async function placeVideo(ctx: OmniContext, file: VideoFile, mode: ImportMode): Promise<VideoEffect> {
	const [video] = await ctx.controllers.media.create_video_elements([file])
	const vw = video.element.videoWidth, vh = video.element.videoHeight
	if (!vw || !vh) throw new BridgeError("import_failed", "The browser could not decode this video (no video track / unsupported codec).")

	const isFirst = ctx.state.effects.length === 0
	if (isFirst) {
		fitProjectToVideo(ctx, vw, vh, video.fps)
		while (ctx.state.tracks.length < 2) ctx.actions.add_track()
	}

	const state = ctx.state
	const frame = 1000 / state.timebase
	// same as Omniclip's own "add to timeline": duration snapped to the timebase minus a 200ms safety margin
	// (upstream avoids requesting frames past the last decodable one, which would stall the export)
	const duration = Math.max(frame, Math.floor(video.duration / frame) * frame - 200)
	const cw = state.settings.width, ch = state.settings.height
	const scale = Math.min(cw / vw, ch / vh)

	const selected = state.selected_effect ? state.effects.find(e => e.id === state.selected_effect!.id) : undefined
	let track = state.tracks.length - 1
	let position = 0
	let replace: AnyEffect | undefined
	if (mode === "replace") {
		if (!selected || selected.kind !== "video") throw new BridgeError("no_selection", "Select the video clip you want to replace in the timeline first.")
		replace = selected
		track = selected.track
		position = selected.start_at_position
	} else if (!isFirst) {
		const mainVideo = [...state.effects].reverse().find(e => e.kind === "video")
		track = mainVideo ? mainVideo.track : track
		position = trackEnd(state.effects, track)
	}

	const visibleLength = replace ? Math.min(duration, replace.end - replace.start) : duration
	const effect: VideoEffect = {
		frames: video.frames,
		id: generate_id(),
		name: video.file.name,
		kind: "video",
		file_hash: video.hash,
		raw_duration: video.duration,
		duration,
		start_at_position: position,
		start: 0,
		end: visibleLength,
		track,
		thumbnail: video.thumbnail,
		rect: {
			position_on_canvas: {x: cw / 2, y: ch / 2},
			width: Math.round(vw * scale),
			height: Math.round(vh * scale),
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			pivot: {x: vw / 2, y: vh / 2},
		},
	}
	ctx.controllers.compositor.managers.videoManager.add_video_effect(effect, video.file)
	if (replace) {
		// add first, then remove: the track never becomes empty, so track indexes stay stable
		ctx.controllers.timeline.set_selected_effect(replace, ctx.state)
		ctx.controllers.timeline.remove_selected_effect(ctx.state)
	}
	const added = ctx.state.effects.find(e => e.id === effect.id) as VideoEffect
	ctx.controllers.timeline.set_selected_effect(added, ctx.state)
	refreshCanvas(ctx)
	return added
}

export interface ImportRequest {
	url?: string
	buffer?: ArrayBuffer
	generationId: string
	mode?: ImportMode
	name?: string
}

let importQueue: Promise<unknown> = Promise.resolve()

/** Import a generated video: media library + timeline. Idempotent for mode "auto". */
export function importGenerated(req: ImportRequest) {
	const run = async () => {
		const mode: ImportMode = req.mode ?? "auto"
		const generationId = String(req.generationId || "unknown")
		const ctx = await readyContext()
		const projectId = ctx.state.projectId
		const imports = readImports(projectId)
		if (mode === "auto" && imports[generationId]) {
			const result = {...imports[generationId], generationId, mode, skipped: true}
			post({type: "reelforge:imported", ...result})
			return result
		}
		const name = req.name ?? `higgsfield-${generationId}.mp4`
		const file = req.buffer
			? new File([req.buffer], name, {type: "video/mp4"})
			: await fetchFile(req.url ?? "", name)
		const media = await ensureInLibrary(ctx, file)
		if (media.kind !== "video") throw new BridgeError("not_a_video", "The imported file is not a video.")
		const effect = await placeVideo(ctx, media, mode === "auto" ? "append" : mode)
		const record: ImportRecord = {hash: media.hash, effectId: effect.id, mode, at: Date.now()}
		writeImports(projectId, {...readImports(projectId), [generationId]: record})
		const result = {generationId, mode, hash: media.hash, effectId: effect.id, durationMs: effect.end - effect.start, skipped: false}
		post({type: "reelforge:imported", ...result})
		return result
	}
	const p = importQueue.then(run).catch(e => {
		postError(e, {generationId: req.generationId, request: "import"})
		throw e
	})
	importQueue = p.catch(() => {})
	return p
}

export interface TextOptions {
	startMs?: number
	durationMs?: number
	fontSize?: number
	color?: string
	fontFamily?: string
	/** vertical position as fraction of the canvas height (0 = top, 1 = bottom) */
	y?: number
}

/** Adds a text overlay on the top track (same effect shape as Omniclip's "Add text"). */
export async function addText(text: string, opts: TextOptions = {}): Promise<TextEffect> {
	const ctx = await readyContext()
	const fontFamily = opts.fontFamily ?? "Poppins-Bold"
	try { await document.fonts.load(`64px "${fontFamily}"`) } catch {}
	const state = ctx.state
	const cw = state.settings.width, ch = state.settings.height
	const duration = opts.durationMs ?? 3000
	const effect: TextEffect = {
		id: generate_id(),
		kind: "text",
		start_at_position: opts.startMs ?? 0,
		duration,
		start: 0,
		end: duration,
		track: 0,
		fontSize: opts.fontSize ?? Math.round(Math.min(ch / 12, cw / 10)),
		text,
		fontStyle: "normal",
		fontFamily,
		align: "center",
		fontVariant: "normal",
		fontWeight: "normal",
		fill: [opts.color ?? "#FFFFFF"],
		fillGradientStops: [],
		fillGradientType: 0,
		stroke: "#000000",
		strokeThickness: Math.max(2, Math.round(ch / 270)),
		lineJoin: "round",
		miterLimit: 10,
		textBaseline: "alphabetic",
		letterSpacing: 0,
		dropShadow: false,
		dropShadowDistance: 5,
		dropShadowAlpha: 1,
		dropShadowBlur: 0,
		dropShadowAngle: 0.5,
		dropShadowColor: "#000000",
		breakWords: false,
		wordWrap: false,
		lineHeight: 0,
		leading: 0,
		wordWrapWidth: 100,
		whiteSpace: "pre",
		rect: {
			position_on_canvas: {x: cw / 2, y: ch * (opts.y ?? 0.82)},
			pivot: {x: 0, y: 0},
			scaleX: 1,
			scaleY: 1,
			width: 100,
			height: 20,
			rotation: 0,
		},
	}
	const managers = ctx.controllers.compositor.managers
	managers.textManager.add_text_effect(effect)
	// center the text on its position now that PIXI measured it
	const sprite = managers.textManager.get(effect.id)?.sprite
	if (sprite) {
		const pivot = {x: sprite.width / 2, y: sprite.height / 2}
		ctx.actions.set_pivot(effect, pivot.x, pivot.y)
		sprite.pivot.set(pivot.x, pivot.y)
	}
	refreshCanvas(ctx)
	return ctx.state.effects.find(e => e.id === effect.id) as TextEffect
}

/** Trim a clip to [startMs, endMs) of its source, keeping its timeline position (undoable). */
export async function trimClip(effectId: string, startMs: number, endMs: number) {
	const ctx = await readyContext()
	const effect = ctx.state.effects.find(e => e.id === effectId)
	if (!effect) throw new BridgeError("not_found", `No clip ${effectId}`)
	const frame = 1000 / ctx.state.timebase
	const snap = (v: number) => Math.round(v / frame) * frame
	const start = Math.max(0, snap(startMs))
	const end = Math.min(effect.duration, snap(endMs))
	if (end - start < frame) throw new BridgeError("bad_trim", "Trimmed clip would be shorter than one frame.")
	ctx.actions.set_effect_start(effect, start)
	ctx.actions.set_effect_end(ctx.state.effects.find(e => e.id === effectId)!, end)
	refreshCanvas(ctx)
	return ctx.state.effects.find(e => e.id === effectId)!
}

export function timelineDuration(effects: AnyEffect[]) {
	return effects.reduce((max, e) => Math.max(max, e.start_at_position + (e.end - e.start)), 0)
}

export async function startExport() {
	const ctx = await readyContext()
	if (ctx.state.effects.length === 0) throw new BridgeError("empty_timeline", "Nothing to export, the timeline is empty.")
	if (ctx.state.is_exporting) throw new BridgeError("export_busy", "An export is already running.")
	if (!window.VideoEncoder) throw new BridgeError("webcodecs_unsupported", "Export needs WebCodecs (latest Chrome or Edge).")
	try {
		await ctx.helpers.ffmpeg.isLoading
	} catch {
		throw new BridgeError("ffmpeg_unavailable", "The video encoder (ffmpeg.wasm) could not be loaded. Check the connection and reload the editor.")
	}
	ctx.controllers.video_export.export_start(ctx.state, ctx.state.settings.bitrate)
}

let lastExport: {bytes: Uint8Array, durationMs: number, at: number} | null = null

/** Watches Omniclip's export status and forwards each finished MP4 to the host page. */
function watchExports() {
	let delivered = false
	setInterval(() => {
		const ctx = getContext()
		if (!ctx) return
		const state = ctx.state
		if (state.export_status === "error" && state.is_exporting) {
			if (!delivered) post({type: "reelforge:error", code: "export_failed", message: `Export failed: ${state.log || "muxing error"}`, request: "export"})
			delivered = true
			return
		}
		if (state.export_status !== "complete") {
			delivered = false
			return
		}
		if (delivered || !state.is_exporting) return
		const file = ctx.controllers.video_export.file
		if (!file) return
		delivered = true
		const durationMs = timelineDuration(state.effects)
		lastExport = {bytes: file, durationMs, at: Date.now()}
		const copy = file.slice().buffer
		post({type: "reelforge:exported", projectId: state.projectId, size: file.byteLength, durationMs, mimeType: "video/mp4", buffer: copy}, [copy])
	}, 250)
}

/** Lets the host page know (debounced) that the project changed, so it can autosave to the server. */
function watchChanges() {
	let last = ""
	let lastSelection = ""
	setInterval(() => {
		const id = currentProjectId()
		if (!id) return
		const stored = localStorage.getItem(`omniclip_${id}`) ?? ""
		const settings = localStorage.getItem(`reelforge_settings_${id}`) ?? ""
		const sig = stored.length + ":" + settings + ":" + stored
		if (sig !== last) {
			const first = last === ""
			last = sig
			if (!first) post({type: "reelforge:changed", projectId: id})
		}
		const sel = getContext()?.state.selected_effect
		const selSig = sel ? `${sel.id}:${sel.kind}` : ""
		if (selSig !== lastSelection) {
			lastSelection = selSig
			post({type: "reelforge:selection", effectId: sel?.id ?? null, kind: sel?.kind ?? null})
		}
	}, 1500)
}

async function snapshot(knownHashes: string[]) {
	const ctx = await readyContext()
	const state = ctx.state
	const projectId = state.projectId
	const imports = readImports(projectId)
	const hashes = new Set<string>()
	for (const e of state.effects) if ("file_hash" in e) hashes.add(e.file_hash)
	for (const r of Object.values(imports)) hashes.add(r.hash)
	const known = new Set(knownHashes)
	const media: {hash: string, name: string, type: string, kind: string, buffer?: ArrayBuffer}[] = []
	const transfer: ArrayBuffer[] = []
	for (const hash of hashes) {
		const m = ctx.controllers.media.get(hash)
		if (!m) continue
		const item: {hash: string, name: string, type: string, kind: string, buffer?: ArrayBuffer} = {hash, name: m.file.name, type: m.file.type, kind: m.kind}
		if (!known.has(hash)) {
			item.buffer = await m.file.arrayBuffer()
			transfer.push(item.buffer)
		}
		media.push(item)
	}
	const historical: Partial<HistoricalState> = JSON.parse(localStorage.getItem(`omniclip_${projectId}`) ?? "{}")
	const settings = JSON.parse(localStorage.getItem(`reelforge_settings_${projectId}`) ?? "null")
	post({type: "reelforge:snapshot", projectId, state: historical, settings, imports, media}, transfer)
}

/** Restores a server-saved project into this browser (media from durable URLs, then state), then reloads. */
async function restoreProject(project: SavedProject) {
	const projectId = currentProjectId()
	if (!projectId || project.projectId !== projectId) throw new BridgeError("bad_project", "Saved project does not match the open project.")
	const ctx = await readyContext()
	for (const m of project.media ?? []) {
		if (ctx.controllers.media.get(m.hash)) continue
		const file = await fetchFile(m.url, m.name ?? m.hash, "any")
		const typed = m.type && file.type === "application/octet-stream" ? new File([file], file.name, {type: m.type}) : file
		await ensureInLibrary(ctx, typed, m.hash)
	}
	localStorage.setItem(`omniclip_${projectId}`, JSON.stringify({...project.state, projectId}))
	if (project.settings) localStorage.setItem(`reelforge_settings_${projectId}`, JSON.stringify(project.settings))
	writeImports(projectId, {...(project.imports ?? {}), ...readImports(projectId)})
	sessionStorage.setItem(`reelforge_restored_${projectId}`, "1")
	location.reload()
}

function hasLocalProject(projectId: string) {
	try {
		const stored = JSON.parse(localStorage.getItem(`omniclip_${projectId}`) ?? "null")
		return !!stored && Array.isArray(stored.effects) && stored.effects.length > 0
	} catch { return false }
}

function listen(onInit: (data: any) => void) {
	window.addEventListener("message", async event => {
		if (!allowedParentOrigins.includes(event.origin) || event.source !== window.parent) return
		const data = event.data
		if (!data || typeof data.type !== "string" || !data.type.startsWith("reelforge:")) return
		parentOrigin = event.origin
		try {
			switch (data.type) {
				case "reelforge:init": onInit(data); break
				case "reelforge:import": await importGenerated({url: data.url, buffer: data.buffer, generationId: data.generationId, mode: data.mode, name: data.name}); break
				case "reelforge:export": await startExport(); break
				case "reelforge:snapshot-request": await snapshot(Array.isArray(data.knownHashes) ? data.knownHashes : []); break
				case "reelforge:load-project": await restoreProject(data.project); break
			}
		} catch (e) {
			if (data.type !== "reelforge:import") postError(e, {request: data.type})
		}
	})
}

export function startBridge() {
	let resolveInit: (data: any) => void = () => {}
	const init = new Promise<any>(r => (resolveInit = r))
	listen(data => resolveInit(data))
	watchExports()
	watchChanges()

	window.reelforge = {
		version: 1,
		context: () => getContext(),
		readyContext,
		importGenerated,
		addText,
		trimClip,
		startExport,
		timelineDuration,
		lastExport: () => lastExport,
	}

	const boot = async () => {
		const projectId = currentProjectId()
		if (!projectId) return
		const ctx = await readyContext()
		const local = hasLocalProject(projectId)
		post({type: "reelforge:ready", projectId, hasLocalProject: local, imports: readImports(projectId), effects: ctx.state.effects.length})
		if (embedded) {
			const msg = await Promise.race([init, sleep(4000).then(() => null)])
			const restoredAlready = sessionStorage.getItem(`reelforge_restored_${projectId}`) === "1"
			if (msg?.project && !local && !restoredAlready) {
				try { await restoreProject(msg.project) } catch (e) { postError(e, {request: "reelforge:init"}) }
				return
			}
		}
		const src = params.get("src")
		if (src) {
			await importGenerated({url: src, generationId: params.get("gen") ?? src, mode: "auto"}).catch(() => {})
		}
	}

	let booted = ""
	const maybeBoot = () => {
		const id = currentProjectId()
		if (id && id !== booted) {
			booted = id
			boot().catch(e => postError(e, {request: "boot"}))
		}
	}
	window.addEventListener("hashchange", maybeBoot)
	maybeBoot()
}