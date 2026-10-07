import {getGeneration, isMockId, type AdaptedGeneration} from "@reelforge/higgsfield"

import {config} from "./config.ts"
import {ApiError} from "./errors.ts"
import {getGenerationRecord, saveGenerationRecord} from "./store.ts"

export type ResolvedGeneration = Omit<AdaptedGeneration, "raw"> & {mock?: boolean, assetId?: string}

const firstSeen = new Map<string, number>()

/**
 * Mock generations (no credits, offline). Scenarios are picked by id prefix:
 *   mock-*          completed immediately (bundled 5 s 720x1280 H.264+AAC sample)
 *   mock-slow-*     queued -> processing -> completed after ~6 s (exercises the loading UI)
 *   mock-fail-*     failed
 *   mock-expired-*  completed, but the provider URL is gone (exercises the expired-URL path)
 */
function mockGeneration(id: string): ResolvedGeneration {
	const sample = `${config.publicUrl}/api/mock/sample.mp4`
	if (id.startsWith("mock-fail")) return {generationId: id, status: "failed", error: "Mock: generation failed (simulated).", mock: true}
	if (id.startsWith("mock-expired")) return {generationId: id, status: "completed", videoUrl: `${config.publicUrl}/api/mock/expired.mp4`, mock: false}
	if (id.startsWith("mock-slow")) {
		const t0 = firstSeen.get(id) ?? Date.now()
		firstSeen.set(id, t0)
		const age = Date.now() - t0
		if (age < 2000) return {generationId: id, status: "queued", mock: true}
		if (age < 6000) return {generationId: id, status: "processing", mock: true}
	}
	return {generationId: id, status: "completed", videoUrl: sample, mock: true}
}

export async function resolveGeneration(id: string, opts: {mock?: boolean} = {}): Promise<ResolvedGeneration> {
	if (opts.mock || isMockId(id) || config.videoBackend === "mock") return mockGeneration(id.startsWith("mock-") ? id : `mock-${id}`)
	// webhook deliveries are authoritative once terminal
	const record = await getGenerationRecord(id)
	if (record && (record.status === "completed" || record.status === "failed") && (record.videoUrl || record.error)) {
		return {generationId: id, status: record.status, videoUrl: record.videoUrl, thumbnailUrl: record.thumbnailUrl, error: record.error, assetId: record.assetId}
	}
	let g: AdaptedGeneration
	try {
		g = await getGeneration(id)
	} catch (e) {
		const err = e as {code?: string, httpStatus?: number, message?: string}
		if (err.code === "not_found") throw new ApiError(404, "generation_not_found", "Higgsfield does not know this generation id (or it belongs to another account).")
		if (err.code === "missing_credentials" || err.code === "bad_credentials_format") throw new ApiError(500, "server_misconfigured", "Higgsfield credentials are not configured on the server.")
		if (err.code === "unauthorized") throw new ApiError(502, "upstream_auth", "Higgsfield rejected the server credentials.")
		throw new ApiError(502, "upstream_error", err.message ?? "Higgsfield request failed.")
	}
	const {raw: _raw, ...adapted} = g
	await saveGenerationRecord(id, {status: adapted.status, videoUrl: adapted.videoUrl, thumbnailUrl: adapted.thumbnailUrl, error: adapted.error})
	return {...adapted, assetId: record?.assetId}
}