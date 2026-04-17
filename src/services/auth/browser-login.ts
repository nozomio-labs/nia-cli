/**
 * Browser device-flow orchestration: open browser, poll until API key is ready.
 */

import { confirm, input, spinner } from "@crustjs/prompts";
import open from "open";
import {
	type DeviceSession,
	exchangeForApiKey,
	formatUserCode,
	getSessionTimeRemaining,
	isDeviceFlowError,
	isSessionValid,
	startDeviceSession,
} from "./device-flow.ts";

const NIA_APP_URL = process.env.NIA_APP_URL?.trim() || "https://app.trynia.ai";

const DEFAULT_BROWSER_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

const POLL_INTERVAL_MS = 2000;
const MAX_NETWORK_ERRORS = 5;
const MAX_SESSION_RETRIES = 2;

/**
 * Max time to wait for browser authorization before falling back to manual entry.
 * Override with `NIA_AUTH_BROWSER_TIMEOUT_MS` (milliseconds, positive integer).
 */
export function resolveBrowserAuthTimeoutMs(): number {
	const raw = process.env.NIA_AUTH_BROWSER_TIMEOUT_MS?.trim();
	if (raw) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) {
			return n;
		}
	}
	return DEFAULT_BROWSER_AUTH_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPastDeadline(deadline: number): boolean {
	return Date.now() >= deadline;
}

function isValidApiKeyFormat(key: string): boolean {
	return key.startsWith("nia_") || key.startsWith("nk_");
}

/**
 * Prompt for API key manually (paste).
 */
export async function promptForManualApiKey(): Promise<string> {
	const shouldOpen = await confirm({
		message: `Open ${NIA_APP_URL} to get your API key?`,
		default: true,
	});

	if (shouldOpen) {
		try {
			await open(NIA_APP_URL);
		} catch {
			console.info("Could not open browser. Please go to the URL manually.");
		}
	} else {
		console.info(`Get your API key at: ${NIA_APP_URL}`);
	}

	return await input({
		message: "Paste your API key:",
		placeholder: "nia_…",
		validate: (value) => {
			if (!value) return "API key is required";
			if (!isValidApiKeyFormat(value)) {
				return "API key should start with nia_ or nk_";
			}
			if (value.length < 10) return "API key is too short";
			return true;
		},
	});
}

async function fallbackManualAfterTimeout(): Promise<string> {
	console.error(
		"Timed out waiting for browser sign-in. You can paste an API key instead.",
	);
	return await promptForManualApiKey();
}

export interface RunBrowserDeviceLoginOptions {
	/** Called with verification URL after session starts (for tests). */
	onVerificationReady?: (session: DeviceSession) => void | Promise<void>;
	/** Override wait timeout before manual fallback (defaults to env / 10 minutes). */
	browserAuthTimeoutMs?: number;
}

/**
 * Run full device flow: connect, show code, open browser, poll until key received.
 */
export async function runBrowserDeviceLogin(
	options: RunBrowserDeviceLoginOptions = {},
): Promise<string> {
	let session: DeviceSession;

	try {
		session = await spinner({
			message: "Connecting to Nia...",
			task: async () => startDeviceSession(),
		});
	} catch (error) {
		if (isDeviceFlowError(error)) {
			console.error(error.message);
		} else {
			console.error(
				"Failed to connect to Nia servers. Check your internet connection.",
			);
		}
		console.error("Falling back to manual API key entry.");
		return await promptForManualApiKey();
	}

	const formattedCode = formatUserCode(session.user_code);
	const timeRemaining = getSessionTimeRemaining(session);
	const mins = Math.floor(timeRemaining / 60);

	console.info("");
	console.info("Browser authorization");
	console.info(`  Your code: ${formattedCode}`);
	console.info(`  Expires in about ${mins} minute(s)`);
	console.info("");

	try {
		await open(session.verification_url);
	} catch {
		console.error("Could not open browser automatically.");
	}

	console.info("");
	console.info("If the browser did not open, visit:");
	console.info(`  ${session.verification_url}`);
	console.info("");
	console.info("Complete sign-in in the browser. Waiting for authorization...");
	if (options.onVerificationReady) {
		await options.onVerificationReady(session);
	}

	const timeoutMs =
		options.browserAuthTimeoutMs ?? resolveBrowserAuthTimeoutMs();
	return await waitForAuthorizationAndExchange(session, timeoutMs);
}

async function waitForAuthorizationAndExchange(
	initialSession: DeviceSession,
	timeoutMs: number,
): Promise<string> {
	let session = initialSession;
	let sessionRetries = 0;
	let consecutiveNetworkErrors = 0;
	let pollCount = 0;
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (isPastDeadline(deadline)) {
			return await fallbackManualAfterTimeout();
		}

		if (!isSessionValid(session)) {
			if (sessionRetries < MAX_SESSION_RETRIES) {
				sessionRetries++;
				console.error("Session expired — starting a new authorization code...");

				try {
					session = await startDeviceSession();
					const formattedCode = formatUserCode(session.user_code);
					const timeRemaining = getSessionTimeRemaining(session);
					const mins = Math.floor(timeRemaining / 60);

					console.error("");
					console.error(`New code: ${formattedCode} (expires in ~${mins} min)`);
					try {
						await open(session.verification_url);
					} catch {
						/* ignore */
					}
					console.error(session.verification_url);
					console.error("");

					pollCount = 0;
					consecutiveNetworkErrors = 0;
					continue;
				} catch {
					console.error("Falling back to manual API key entry.");
					return await promptForManualApiKey();
				}
			}

			console.error("Authorization session expired after multiple attempts.");
			process.exit(1);
		}

		const remaining = getSessionTimeRemaining(session);
		const mins = Math.floor(remaining / 60);
		const secs = remaining % 60;
		const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;

		try {
			const apiKey = await exchangeForApiKey(session);
			return apiKey;
		} catch (error) {
			if (isDeviceFlowError(error)) {
				switch (error.type) {
					case "not_ready":
						consecutiveNetworkErrors = 0;
						break;

					case "expired":
						session = { ...session, expires_at: new Date(0).toISOString() };
						consecutiveNetworkErrors = 0;
						break;

					case "consumed":
						console.error("This session was already used. Run login again.");
						process.exit(1);
						break;

					case "invalid":
						console.error(error.message);
						process.exit(1);
						break;

					case "network":
						consecutiveNetworkErrors++;
						if (consecutiveNetworkErrors >= MAX_NETWORK_ERRORS) {
							console.error(
								`Failed to reach Nia servers after ${MAX_NETWORK_ERRORS} attempts.`,
							);
							console.error("Falling back to manual API key entry.");
							return await promptForManualApiKey();
						}
						break;

					default:
						console.error(error.message);
						console.error("Falling back to manual API key entry.");
						return await promptForManualApiKey();
				}
			} else {
				consecutiveNetworkErrors++;
				if (consecutiveNetworkErrors >= MAX_NETWORK_ERRORS) {
					console.error("Lost connection to Nia servers.");
					console.error("Falling back to manual API key entry.");
					return await promptForManualApiKey();
				}
			}
		}

		pollCount++;
		const backoff =
			consecutiveNetworkErrors > 0
				? POLL_INTERVAL_MS * Math.min(consecutiveNetworkErrors, 4)
				: POLL_INTERVAL_MS;

		if (pollCount > 0 && pollCount % 15 === 0) {
			console.error(
				`Still waiting... (${timeStr}) — ${session.verification_url}`,
			);
		}

		const msLeft = deadline - Date.now();
		if (msLeft <= 0) {
			return await fallbackManualAfterTimeout();
		}
		await sleep(Math.min(backoff, msLeft));
	}
}
