#!/usr/bin/env node
// Cross-platform replacement for Omniclip's bash-only `turtle-standard` + `prepare-dist`
// (upstream scripts use bash, `ln -s`, `cp -r`, which do not work on Windows).
//
//   node scripts/build.mjs          -> x/ with junctions to node_modules + s (fast, for local dev)
//   node scripts/build.mjs --dist   -> x/ with real copies of production node_modules + s (deployable folder)
//
// Output: packages/editor/omniclip/x  (serve it at the ROOT of an origin, see scripts/serve.mjs)
import {spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, "../omniclip")
const x = path.join(app, "x")
const dist = process.argv.includes("--dist")

function run(label, cmd, args, opts = {}) {
	console.log(`[editor build] ${label}`)
	const r = spawnSync(cmd, args, {cwd: app, stdio: "inherit", ...opts})
	if (r.status !== 0) {
		console.error(`[editor build] step failed: ${label} (exit ${r.status})`)
		process.exit(r.status ?? 1)
	}
	return r
}

if (!fs.existsSync(path.join(app, "node_modules"))) {
	console.log("[editor build] installing Omniclip dependencies (npm, own lockfile)")
	run("npm install", "npm", ["install", "--no-audit", "--no-fund"], {shell: true})
}

// 1. clean
fs.rmSync(x, {recursive: true, force: true})
fs.mkdirSync(x, {recursive: true})

// 2. import map (importly reads the npm lockfile)
{
	const lock = fs.readFileSync(path.join(app, "package-lock.json"))
	const r = run("importmap", process.execPath, [path.join(app, "node_modules/importly/x/cli.js"), "--host=node_modules"], {input: lock, stdio: ["pipe", "pipe", "inherit"]})
	// ReelForge: page-relative import map so the editor can be served at "/" or under a sub-path like "/editor/"
	// (es-module-shims resolves import-map addresses against the import map's own URL)
	fs.writeFileSync(path.join(x, "importmap.json"), String(r.stdout).replaceAll('"/node_modules/', '"./node_modules/'))
}

// 3. typescript
run("tsc", process.execPath, [path.join(app, "node_modules/typescript/bin/tsc"), "-p", path.join(app, "tsconfig.json")])

// 4. static files from s/ (index.html, css). Upstream used turtle's html templates, which do not run on
//    Windows (absolute-path dynamic import); ReelForge ships a plain s/index.html instead.
function copyStatic(dir) {
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		const src = path.join(dir, entry.name)
		if (entry.isDirectory()) copyStatic(src)
		else if (/\.(html|css)$/.test(entry.name)) {
			const dest = path.join(x, path.relative(path.join(app, "s"), src))
			fs.mkdirSync(path.dirname(dest), {recursive: true})
			fs.copyFileSync(src, dest)
		}
	}
}
console.log("[editor build] static files")
copyStatic(path.join(app, "s"))
// default runtime config for static hosting (scripts/serve.mjs serves a dynamic one from env instead)
fs.writeFileSync(path.join(x, "reelforge-config.js"), `window.REELFORGE_CONFIG = ${JSON.stringify({
	allowedParentOrigins: (process.env.EDITOR_ALLOWED_PARENT_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
	allowedMediaOrigins: (process.env.EDITOR_ALLOWED_MEDIA_ORIGINS ?? "http://localhost:3001,http://127.0.0.1:3001").split(","),
})};\n`)

// 5. assets
fs.cpSync(path.join(app, "assets"), path.join(x, "assets"), {recursive: true})

// 6. node_modules + sources (sourcemaps reference ../s)
function link(target, name) {
	const dest = path.join(x, name)
	fs.rmSync(dest, {recursive: true, force: true})
	fs.symlinkSync(target, dest, "junction")
}
if (dist) {
	console.log("[editor build] copying node_modules + s into x (dist mode)")
	const devOnly = /[\\/]node_modules[\\/](typescript|@types|rollup|@rollup|terser|jest|@jest|chai|cynic|chokidar|chokidar-cli|http-server|importly|@benev[\\/]turtle)([\\/]|$)/
	fs.cpSync(path.join(app, "node_modules"), path.join(x, "node_modules"), {recursive: true, dereference: true, filter: src => !devOnly.test(src)})
	fs.cpSync(path.join(app, "s"), path.join(x, "s"), {recursive: true})
} else {
	link(path.join(app, "node_modules"), "node_modules")
	link(path.join(app, "s"), "s")
}

console.log(`[editor build] done -> ${x}`)