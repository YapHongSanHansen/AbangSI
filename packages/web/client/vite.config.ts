import {defineConfig} from "vite"
import react from "@vitejs/plugin-react"
import {fileURLToPath} from "node:url"

const api = process.env.WEB_SERVER_URL ?? "http://127.0.0.1:3001"

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	server: {
		port: 5173,
		strictPort: true,
		host: "localhost",
		// dev: same-origin like production, the API server also serves the built editor under /editor/
		proxy: {
			"/api": {target: api, changeOrigin: false},
			"/editor": {target: api, changeOrigin: false},
		},
	},
	build: {outDir: "dist", emptyOutDir: true},
})