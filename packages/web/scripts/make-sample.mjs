#!/usr/bin/env node
// Generates the bundled mock "Higgsfield output": 5 s, 720x1280 (9:16), 25 fps, H.264 + AAC, faststart.
// Used by GET /api/generations/:id?mock=1 so the whole flow works offline and without spending credits.
import {spawnSync} from "node:child_process"
import {createRequire} from "node:module"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const require = createRequire(import.meta.url)
const ffmpeg = require("ffmpeg-static")
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/assets/mock-generation.mp4")
fs.mkdirSync(path.dirname(out), {recursive: true})
if (fs.existsSync(out) && !process.argv.includes("--force")) {
	console.log(`[mock] ${out} already exists`)
	process.exit(0)
}
const r = spawnSync(ffmpeg, [
	"-y",
	"-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=25:duration=5",
	"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
	"-vf", "drawbox=x=0:y=ih*0.42:w=iw:h=ih*0.16:color=0x7c5cff@0.6:t=fill",
	"-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-preset", "veryfast", "-crf", "23",
	"-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
	out,
], {stdio: "inherit"})
if (r.status !== 0) process.exit(r.status ?? 1)
console.log(`[mock] wrote ${out} (${fs.statSync(out).size} bytes)`)