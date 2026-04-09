import { resolveApiKey, resolveBaseUrl } from "../config.ts";
import type { LocalSource, LocalSyncUploadPayload } from "./types.ts";

interface RequestOptions {
	apiKey?: string;
	method: "GET" | "POST" | "DELETE";
	path: string;
	payload?: Record<string, unknown>;
}

export class LocalApiError extends Error {
	status?: number;
	body?: unknown;

	constructor(message: string, status?: number, body?: unknown) {
		super(message);
		this.name = "LocalApiError";
		this.status = status;
		this.body = body;
	}
}

async function requestJson<T>({
	apiKey: apiKeyOverride,
	method,
	path,
	payload,
}: RequestOptions): Promise<T> {
	const apiKey = await resolveApiKey(apiKeyOverride);
	if (!apiKey) {
		throw new Error(
			"No API key found. Run `nia auth login` to authenticate, or set the NIA_API_KEY environment variable.",
		);
	}

	const baseUrl = await resolveBaseUrl();
	const url = `${baseUrl.replace(/\/$/, "")}${path}`;

	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: payload ? JSON.stringify(payload) : undefined,
	});

	const text = await response.text();
	let data: unknown;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}

	if (!response.ok) {
		const detail =
			typeof data === "object" && data !== null && "detail" in data
				? String((data as { detail: unknown }).detail)
				: typeof data === "string"
					? data
					: response.statusText;
		throw new LocalApiError(detail || "Request failed", response.status, data);
	}

	return data as T;
}

export async function listLocalSources(
	apiKey?: string,
): Promise<LocalSource[]> {
	const result = await requestJson<unknown>({
		apiKey,
		method: "GET",
		path: "/daemon/sources",
	});

	if (!Array.isArray(result)) {
		throw new Error("Unexpected response while loading local sources.");
	}

	return result as LocalSource[];
}

export async function addLocalSource(
	path: string,
	apiKey?: string,
	options?: { detectedType?: string; displayName?: string },
): Promise<LocalSource> {
	const result = await requestJson<unknown>({
		apiKey,
		method: "POST",
		path: "/daemon/sources",
		payload: {
			path,
			// Forward the detected_type to the daemon. Defaults to "folder" for
			// generic directory sources; personal-data sources (iMessage, Apple
			// Notes, Safari history, etc.) pass their specific connector key here
			// so the backend's db_extractor.py knows which extractor to apply.
			detected_type: options?.detectedType ?? "folder",
			...(options?.displayName ? { display_name: options.displayName } : {}),
		},
	});

	if (!result || typeof result !== "object") {
		throw new Error("Unexpected response while adding local source.");
	}

	return result as LocalSource;
}

export async function enableLocalSourceSync(
	id: string,
	path: string,
	apiKey?: string,
): Promise<boolean> {
	const result = await requestJson<unknown>({
		apiKey,
		method: "POST",
		path: `/daemon/sources/${encodeURIComponent(id)}/enable`,
		payload: { path },
	});

	return Boolean(result);
}

export async function removeLocalSource(
	id: string,
	apiKey?: string,
): Promise<boolean> {
	const result = await requestJson<unknown>({
		apiKey,
		method: "DELETE",
		path: `/daemon/sources/${encodeURIComponent(id)}`,
	});

	return Boolean(result);
}

export async function uploadLocalSyncBatch(
	payload: LocalSyncUploadPayload,
	apiKey?: string,
): Promise<Record<string, unknown>> {
	const result = await requestJson<unknown>({
		apiKey,
		method: "POST",
		path: "/daemon/sync",
		payload: payload as unknown as Record<string, unknown>,
	});

	if (!result || typeof result !== "object") {
		throw new Error("Unexpected response while uploading local sync batch.");
	}

	return result as Record<string, unknown>;
}

export async function reportLocalSyncError(
	id: string,
	error: string,
	path?: string,
	apiKey?: string,
): Promise<void> {
	try {
		await requestJson({
			apiKey,
			method: "POST",
			path: `/daemon/sources/${encodeURIComponent(id)}/error`,
			payload: {
				error,
				path,
			},
		});
	} catch {
		// Best effort; do not mask the original sync failure.
	}
}
