/**
 * Device authorization flow for CLI login (browser sign-in → API key).
 * Mirrors `nia-wizard` — POST /public/mcp-device/start then poll /public/mcp-device/exchange.
 */

import { randomUUID } from "node:crypto";

/** Backend host for device endpoints (no /v2 prefix). */
export function resolveDeviceBackendUrl(): string {
	const explicit = process.env.NIA_BACKEND_URL?.trim();
	if (explicit) {
		return explicit.replace(/\/$/, "");
	}
	return "https://apigcp.trynia.ai";
}

const APP_URL = process.env.NIA_APP_URL?.trim() ?? "";

const FETCH_TIMEOUT_MS = 10_000;

export interface DeviceSession {
	authorization_session_id: string;
	user_code: string;
	verification_url: string;
	expires_at: string;
}

export interface DeviceFlowError {
	type:
		| "network"
		| "expired"
		| "not_ready"
		| "consumed"
		| "invalid"
		| "unknown";
	message: string;
	detail?: string;
}

function createError(
	type: DeviceFlowError["type"],
	message: string,
	detail?: string,
): DeviceFlowError {
	return { type, message, detail };
}

export function isDeviceFlowError(error: unknown): error is DeviceFlowError {
	return (
		typeof error === "object" &&
		error !== null &&
		"type" in error &&
		"message" in error
	);
}

/**
 * Start a new device authorization session.
 */
export async function startDeviceSession(): Promise<DeviceSession> {
	const backend = resolveDeviceBackendUrl();

	const response = await fetch(`${backend}/public/mcp-device/start`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");

		if (response.status === 429) {
			throw createError(
				"network",
				"Too many requests. Please wait a moment and try again.",
			);
		}

		throw createError(
			"network",
			`Failed to connect to Nia servers: ${response.status} — ${errorText}`,
		);
	}

	const data = (await response.json()) as {
		authorization_session_id: string;
		user_code: string;
		verification_url: string;
		expires_at: string;
	};

	const sid = randomUUID();
	let verificationUrl: string;
	if (APP_URL) {
		verificationUrl = `${APP_URL.replace(/\/$/, "")}/cli-onboarding?code=${data.user_code}&sid=${sid}`;
	} else {
		verificationUrl =
			data.verification_url.replace("/cli-auth?", "/cli-onboarding?") +
			`&sid=${sid}`;
	}

	return {
		authorization_session_id: data.authorization_session_id,
		user_code: data.user_code,
		verification_url: verificationUrl,
		expires_at: data.expires_at,
	};
}

/**
 * Exchange a device session for an API key.
 */
export async function exchangeForApiKey(
	session: DeviceSession,
): Promise<string> {
	const backend = resolveDeviceBackendUrl();

	const expiresAt = new Date(session.expires_at).getTime();
	if (Date.now() > expiresAt) {
		throw createError(
			"expired",
			"Session has expired. Please run login again.",
		);
	}

	const response = await fetch(`${backend}/public/mcp-device/exchange`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			authorization_session_id: session.authorization_session_id,
			user_code: session.user_code,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorData = (await response
			.json()
			.catch(() => ({ detail: "Unknown error" }))) as { detail?: string };
		const detail = errorData.detail || `HTTP ${response.status}`;

		switch (response.status) {
			case 400:
				if (
					detail.includes("not yet authorized") ||
					detail.includes("pending")
				) {
					throw createError(
						"not_ready",
						"Session not yet authorized. Complete the setup in your browser first.",
						detail,
					);
				}
				if (
					detail.includes("complete the setup") ||
					detail.includes("authorized")
				) {
					throw createError(
						"not_ready",
						"Please complete the setup in your browser first (sign in, etc.).",
						detail,
					);
				}
				throw createError("invalid", detail);

			case 404:
				throw createError(
					"invalid",
					"Invalid session or code. Please run login again.",
				);

			case 409:
				throw createError(
					"consumed",
					"This session has already been used. Please run login again.",
				);

			case 410:
				throw createError(
					"expired",
					"Session has expired. Please run login again.",
				);

			default:
				throw createError("unknown", `Failed to get API key: ${detail}`);
		}
	}

	const data = (await response.json()) as { api_key?: string };

	if (!data.api_key) {
		throw createError("unknown", "Server did not return an API key");
	}

	return data.api_key;
}

export function isSessionValid(session: DeviceSession): boolean {
	const expiresAt = new Date(session.expires_at).getTime();
	return Date.now() < expiresAt - 30_000;
}

export function getSessionTimeRemaining(session: DeviceSession): number {
	const expiresAt = new Date(session.expires_at).getTime();
	const remaining = Math.max(0, expiresAt - Date.now());
	return Math.floor(remaining / 1000);
}

export function formatUserCode(code: string): string {
	return code.toUpperCase();
}
