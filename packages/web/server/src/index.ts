import {config} from "./config.ts"
import {createApp} from "./app.ts"

const app = createApp()
// bind IPv4 and (if available) IPv6 loopback so both "localhost" resolutions work (tunnels, browsers)
const hosts = config.host === "127.0.0.1" ? ["127.0.0.1", "::1"] : [config.host]
for (const host of hosts) {
	const server = app.listen(config.port, host, () => {
		if (host === hosts[0]) {
			console.log(`[server] ReelForge on http://localhost:${config.port} (public ${config.publicUrl})`)
			console.log(`[server] higgsfield key configured: ${config.hasHiggsfieldKey ? "yes" : "no"}; video backend: ${config.videoBackend || "higgsfield"}; media store: ${config.mediaDir}`)
		}
	})
	server.on("error", err => {
		if (host === hosts[0]) throw err
		console.warn(`[server] not listening on ${host}: ${(err as Error).message}`)
	})
}