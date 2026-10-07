import path from "node:path"
import {fileURLToPath} from "node:url"
import dotenv from "dotenv"

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// Secrets (HIGGSFIELD_API_KEY, ...) come from the monorepo root .env and stay on this server.
dotenv.config({path: path.resolve(webRoot, "../../.env"), quiet: true})

const list = (v: string | undefined, d: string) => (v ?? d).split(",").map(s => s.trim()).filter(Boolean)

export const config = {
	port: Number(process.env.WEB_SERVER_PORT ?? 3001),
	host: process.env.WEB_SERVER_HOST ?? "127.0.0.1",
	/** browser-facing base URL of this API; media URLs handed to the editor are built from it */
	publicUrl: (process.env.WEB_PUBLIC_URL ?? "http://localhost:3001").replace(/\/+$/, ""),
	/** origins allowed to call the API / load media (site + editor) */
	allowedOrigins: list(process.env.WEB_ALLOWED_ORIGINS, "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"),
	mediaDir: path.resolve(process.env.MEDIA_STORE_DIR ?? path.join(webRoot, "media-store")),
	mockSample: path.join(webRoot, "server/assets/mock-generation.mp4"),
	maxDownloadBytes: Number(process.env.MAX_MEDIA_BYTES ?? 1024 * 1024 * 1024),
	/** optional shared token required on the webhook URL (?token=...) */
	webhookToken: process.env.HIGGSFIELD_WEBHOOK_TOKEN ?? "",
	/** public HTTPS URL of /api/higgsfield/webhook (only if reachable from the internet) */
	webhookUrl: process.env.HIGGSFIELD_WEBHOOK_URL ?? "",
	videoBackend: process.env.VIDEO_BACKEND ?? "",
	hasHiggsfieldKey: Boolean(process.env.HIGGSFIELD_API_KEY || process.env.HF_CREDENTIALS),
}