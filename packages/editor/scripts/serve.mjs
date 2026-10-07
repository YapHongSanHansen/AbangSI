#!/usr/bin/env node
// Static server for the built editor (omniclip/x). Omniclip uses absolute /assets and /node_modules paths,
// so it must be served at the ROOT of its own origin (default http://localhost:5174/).
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.env.EDITOR_ROOT ?? path.join(here, "../omniclip/x"))
const port = Number(process.env.EDITOR_PORT ?? 5174)
const host = process.env.EDITOR_HOST ?? "127.0.0.1"
const list = (v, d) => (v ?? d).split(",").map(s => s.trim()).filter(Boolean)
const parentOrigins = list(process.env.EDITOR_ALLOWED_PARENT_ORIGINS, "http://localhost:5173,http://127.0.0.1:5173")
const mediaOrigins = list(process.env.EDITOR_ALLOWED_MEDIA_ORIGINS, "http://localhost:3001,http://127.0.0.1:3001")

const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
	".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject",
	".ts": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
}

if (!fs.existsSync(path.join(root, "index.html"))) {
	console.error(`[editor serve] ${root}/index.html not found, run "pnpm --filter @reelforge/editor build" first`)
	process.exit(1)
}

const configJs = () => `window.REELFORGE_CONFIG = ${JSON.stringify({allowedParentOrigins: parentOrigins, allowedMediaOrigins: mediaOrigins})};\n`

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://x")
	const common = {
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	}
	if (req.method === "OPTIONS") { res.writeHead(204, {...common, "Access-Control-Allow-Headers": "range"}); return res.end() }
	if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, common); return res.end() }

	if (url.pathname === "/reelforge-config.js") {
		res.writeHead(200, {...common, "Content-Type": MIME[".js"]})
		return res.end(configJs())
	}

	let rel
	try { rel = decodeURIComponent(url.pathname) } catch { res.writeHead(400, common); return res.end() }
	if (rel.endsWith("/")) rel += "index.html"
	const file = path.resolve(root, "." + rel)
	if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403, common); return res.end() }

	fs.stat(file, (err, stat) => {
		if (err || !stat.isFile()) { res.writeHead(404, {...common, "Content-Type": "text/plain"}); return res.end("not found") }
		const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"
		const headers = {...common, "Content-Type": type, "Accept-Ranges": "bytes"}
		if (type.startsWith("text/html")) {
			// only our site may embed the editor
			headers["Content-Security-Policy"] = `frame-ancestors 'self' ${parentOrigins.join(" ")}`
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
		if (range && (range[1] || range[2])) {
			let start = range[1] ? Number(range[1]) : stat.size - Number(range[2])
			let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
			if (start >= stat.size || start > end) { res.writeHead(416, {...headers, "Content-Range": `bytes */${stat.size}`}); return res.end() }
			end = Math.min(end, stat.size - 1)
			res.writeHead(206, {...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1})
			if (req.method === "HEAD") return res.end()
			return fs.createReadStream(file, {start, end}).pipe(res)
		}
		res.writeHead(200, {...headers, "Content-Length": stat.size})
		if (req.method === "HEAD") return res.end()
		fs.createReadStream(file).pipe(res)
	})
})

server.listen(port, host, () => {
	console.log(`[editor serve] http://localhost:${port}/  (root ${root})`)
	console.log(`[editor serve] parent origins: ${parentOrigins.join(", ")} | media origins: ${mediaOrigins.join(", ")}`)
})