import fs from "node:fs"
import path from "node:path"
import express, {type Request, type Response, type NextFunction} from "express"
import cors from "cors"
import {createVideo, adaptHiggsfieldResponse, HiggsfieldError} from "@reelforge/higgsfield"

import {config, webRoot} from "./config.ts"
import {ApiError} from "./errors.ts"
import {resolveGeneration} from "./generations.ts"
import {ensureDurable, assetUrls} from "./durable.ts"
import {getAsset, blobPath, isAssetId, putAsset, saveGenerationRecord, getGenerationRecord, getProject, saveProject, listProjects} from "./store.ts"

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
	(req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next)

/** Range-capable file response (media, mock sample) */
function sendFile(req: Request, res: Response, file: string, contentType: string, cache: string) {
	const stat = fs.statSync(file)
	res.setHeader("Content-Type", contentType)
	res.setHeader("Accept-Ranges", "bytes")
	res.setHeader("Cache-Control", cache)
	res.setHeader("X-Content-Type-Options", "nosniff")
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
	if (range && (range[1] || range[2])) {
		const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
		const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
		if (start >= stat.size || start > end) {
			res.status(416).setHeader("Content-Range", `bytes */${stat.size}`)
			return res.end()
		}
		res.status(206)
		res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`)
		res.setHeader("Content-Length", String(end - start + 1))
		if (req.method === "HEAD") return res.end()
		return fs.createReadStream(file, {start, end}).pipe(res)
	}
	res.setHeader("Content-Length", String(stat.size))
	if (req.method === "HEAD") return res.end()
	fs.createReadStream(file).pipe(res)
}

/** Serve a static directory (follows junctions), optional SPA fallback, optional extra headers for html */
function staticDir(dir: string, opts: {spaFallback?: boolean, htmlHeaders?: Record<string, string>, virtual?: Record<string, () => string>} = {}) {
	const root = path.resolve(dir)
	const mime: Record<string, string> = {
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
		".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
		".ico": "image/x-icon", ".mp4": "video/mp4", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
		".eot": "application/vnd.ms-fontobject", ".ts": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
	}
	return (req: Request, res: Response, next: NextFunction) => {
		if (req.method !== "GET" && req.method !== "HEAD") return next()
		let rel: string
		try { rel = decodeURIComponent(req.path) } catch { return res.status(400).end() }
		if (opts.virtual?.[rel]) {
			res.type("text/javascript").setHeader("Cache-Control", "no-cache")
			return res.send(opts.virtual[rel]())
		}
		if (rel.endsWith("/")) rel += "index.html"
		let file = path.resolve(root, "." + rel)
		if (!file.startsWith(root + path.sep)) return res.status(403).end()
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
			if (!opts.spaFallback || path.extname(rel)) return next()
			file = path.join(root, "index.html")
			if (!fs.existsSync(file)) return next()
		}
		const type = mime[path.extname(file).toLowerCase()] ?? "application/octet-stream"
		if (type.startsWith("text/html")) for (const [k, v] of Object.entries(opts.htmlHeaders ?? {})) res.setHeader(k, v)
		const immutable = /[\\/]assets[\\/].+\.[a-f0-9]{8}\./.test(file)
		return sendFile(req, res, file, type, immutable ? "public, max-age=31536000, immutable" : "no-cache")
	}
}

export function createApp() {
	const app = express()
	app.disable("x-powered-by")
	app.set("trust proxy", true)

	const corsMw = cors({
		origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin) || origin === new URL(config.publicUrl).origin),
		exposedHeaders: ["Content-Range", "Content-Length", "Accept-Ranges"],
	})
	app.use("/api", corsMw)

	app.get("/api/health", (_req, res) => {
		res.json({ok: true, higgsfieldConfigured: config.hasHiggsfieldKey, videoBackend: config.videoBackend || "higgsfield", publicUrl: config.publicUrl})
	})

	// --- generations -------------------------------------------------------------------------------
	app.post("/api/generations", express.json({limit: "64kb"}), wrap(async (req, res) => {
		const {prompt, durationSeconds, aspectRatio, model, mock, imageUrl} = req.body ?? {}
		if (typeof prompt !== "string" || prompt.trim().length < 2) throw new ApiError(400, "bad_input", "prompt is required.")
		const useMock = mock === true || model === "mock" || config.videoBackend === "mock"
		try {
			const {generationId} = await createVideo({
				prompt, durationSeconds, aspectRatio, imageUrl,
				model: useMock ? "mock" : model,
				webhookUrl: config.webhookUrl ? `${config.webhookUrl}${config.webhookToken ? `?token=${encodeURIComponent(config.webhookToken)}` : ""}` : undefined,
			})
			await saveGenerationRecord(generationId, {prompt, model: useMock ? "mock" : model, status: useMock ? "completed" : "queued"})
			res.status(201).json({generationId, mock: useMock})
		} catch (e) {
			if (e instanceof HiggsfieldError) throw new ApiError(e.httpStatus && e.httpStatus < 500 ? 400 : 502, `higgsfield_${e.code}`, e.message)
			throw e
		}
	}))

	app.get("/api/generations/:id", wrap(async (req, res) => {
		const id = String(req.params.id)
		const g = await resolveGeneration(id, {mock: req.query.mock === "1"})
		const record = await getGenerationRecord(g.generationId).catch(() => null)
		const assetId = g.assetId ?? record?.assetId
		res.json({...g, durable: assetId && await getAsset(assetId) ? assetUrls(assetId) : undefined})
	}))

	app.post("/api/generations/:id/durable", wrap(async (req, res) => {
		res.json(await ensureDurable(String(req.params.id), {mock: req.query.mock === "1"}))
	}))

	/** Deep-link import: {generationId, videoUrl?, mock?} -> durable same-origin copy */
	app.post("/api/imports", express.json({limit: "16kb"}), wrap(async (req, res) => {
		const {generationId, videoUrl, mock} = req.body ?? {}
		if (typeof generationId !== "string" || !generationId) throw new ApiError(400, "bad_input", "generationId is required.")
		if (videoUrl !== undefined && typeof videoUrl !== "string") throw new ApiError(400, "bad_input", "videoUrl must be a string.")
		res.json(await ensureDurable(generationId, {videoUrl: videoUrl || undefined, mock: mock === true}))
	}))

	// Higgsfield webhook: {request_id, status, error, payload: {video: {url}}}
	app.post("/api/higgsfield/webhook", express.json({limit: "256kb"}), wrap(async (req, res) => {
		if (config.webhookToken && req.query.token !== config.webhookToken) throw new ApiError(401, "bad_token", "Invalid webhook token.")
		const body = req.body
		if (!body || typeof body !== "object" || typeof body.request_id !== "string" || typeof body.status !== "string") {
			throw new ApiError(400, "bad_webhook", "Body does not match the Higgsfield webhook envelope.")
		}
		const g = adaptHiggsfieldResponse(body)
		const current = await getGenerationRecord(g.generationId)
		await saveGenerationRecord(g.generationId, {
			status: g.status, videoUrl: g.videoUrl, thumbnailUrl: g.thumbnailUrl, error: g.error,
			webhookEvents: [...(current?.webhookEvents ?? []), {status: body.status, at: new Date().toISOString()}].slice(-20),
		})
		// copy completed media right away so it outlives the provider URL
		if (g.status === "completed") ensureDurable(g.generationId).catch(err => console.warn("[webhook] durable copy failed:", err.message))
		res.json({ok: true})
	}))

	// --- media ---------------------------------------------------------------------------------------
	app.get(["/api/media/:assetId", "/api/media/:assetId.mp4"], wrap(async (req, res) => {
		const id = String(req.params.assetId).replace(/\.mp4$/, "")
		if (!isAssetId(id)) throw new ApiError(400, "bad_asset_id", "Asset ids are sha256 hex strings.")
		const meta = await getAsset(id)
		if (!meta) throw new ApiError(404, "asset_not_found", "No such media asset.")
		res.setHeader("Content-Disposition", `inline; filename="${(meta.name ?? `${id}.mp4`).replace(/[^\w.-]/g, "_")}"`)
		sendFile(req, res, blobPath(id), meta.contentType, "public, max-age=31536000, immutable")
	}))

	app.post("/api/media/check", express.json({limit: "64kb"}), wrap(async (req, res) => {
		const hashes: unknown[] = Array.isArray(req.body?.hashes) ? req.body.hashes : []
		const present: string[] = []
		for (const h of hashes) if (typeof h === "string" && await getAsset(h)) present.push(h)
		res.json({present})
	}))

	/** raw upload (user media for saved projects, exported edits). Body = file bytes. */
	app.post("/api/media", wrap(async (req, res) => {
		const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
		if (!/^(video|image|audio)\//.test(type)) throw new ApiError(415, "unsupported_media_type", "Upload video/*, image/* or audio/* bytes.")
		const kind = req.query.kind === "export" ? "export" : "upload"
		const name = String(req.headers["x-file-name"] ?? "").slice(0, 200) || undefined
		const meta = await putAsset(req, {contentType: type, name, kind, source: {projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined}})
		res.status(201).json({...assetUrls(meta.assetId), size: meta.size, contentType: meta.contentType})
	}))

	// --- projects ------------------------------------------------------------------------------------
	app.get("/api/projects", wrap(async (_req, res) => { res.json({projects: await listProjects()}) }))

	app.get("/api/projects/:projectId", wrap(async (req, res) => {
		const p = await getProject(String(req.params.projectId))
		if (!p) throw new ApiError(404, "project_not_found", "No saved project with this id.")
		res.json({...p, media: p.media.map(m => ({...m, ...assetUrls(m.hash), url: assetUrls(m.hash).mediaPath}))})
	}))

	app.post("/api/projects/:projectId", express.json({limit: "8mb"}), wrap(async (req, res) => {
		const projectId = String(req.params.projectId)
		const {state, settings, imports, media, name, generationIds} = req.body ?? {}
		if (!state || typeof state !== "object") throw new ApiError(400, "bad_input", "state is required.")
		const list: {hash: string, name?: string, type?: string, kind?: string}[] = Array.isArray(media) ? media : []
		const missing: string[] = []
		for (const m of list) if (!isAssetId(m?.hash) || !await getAsset(m.hash)) missing.push(String(m?.hash))
		if (missing.length) throw new ApiError(409, "media_missing", "Upload these media files before saving the project.", {missing})
		const saved = await saveProject({projectId, name, state, settings, imports, media: list.map(m => ({hash: m.hash, name: m.name, type: m.type, kind: m.kind})), generationIds})
		res.json({ok: true, projectId, updatedAt: saved.updatedAt})
	}))

	// --- mock assets ---------------------------------------------------------------------------------
	app.get("/api/mock/sample.mp4", (req, res) => {
		if (!fs.existsSync(config.mockSample)) return res.status(500).json({error: {code: "mock_missing", message: "Run pnpm --filter @reelforge/web mock:sample"}})
		sendFile(req, res, config.mockSample, "video/mp4", "no-cache")
	})
	app.get("/api/mock/expired.mp4", (_req, res) => { res.status(410).json({error: {code: "expired", message: "Simulated expired URL"}}) })

	app.use("/api", (_req, _res, next) => next(new ApiError(404, "not_found", "Unknown API route.")))

	// --- single-origin hosting: editor under /editor/, built site at / -------------------------------
	const editorDir = path.resolve(process.env.EDITOR_DIR ?? path.join(webRoot, "../editor/omniclip/x"))
	if (fs.existsSync(path.join(editorDir, "index.html"))) {
		app.use("/editor", staticDir(editorDir, {
			htmlHeaders: {"Content-Security-Policy": "frame-ancestors 'self'"},
			virtual: {"/reelforge-config.js": () => `window.REELFORGE_CONFIG = ${JSON.stringify({allowedParentOrigins: [], allowedMediaOrigins: []})};\n`},
		}))
	}
	const clientDist = path.join(webRoot, "client/dist")
	if (fs.existsSync(path.join(clientDist, "index.html"))) app.use(staticDir(clientDist, {spaFallback: true}))

	// --- errors ------------------------------------------------------------------------------------
	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof ApiError) return res.status(err.status).json({error: {code: err.code, message: err.message, details: err.details}})
		const e = err as {type?: string, status?: number, message?: string}
		if (e?.type === "entity.too.large") return res.status(413).json({error: {code: "too_large", message: "Request body too large."}})
		if (e?.type === "entity.parse.failed") return res.status(400).json({error: {code: "bad_json", message: "Malformed JSON."}})
		console.error("[server] unexpected error:", e?.message ?? err)
		res.status(500).json({error: {code: "internal", message: "Unexpected server error."}})
	})
	return app
}