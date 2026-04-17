import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	resolveBrowserAuthTimeoutMs,
	runBrowserDeviceLogin,
} from "../../../src/services/auth/browser-login.ts";

describe("resolveBrowserAuthTimeoutMs", () => {
	const original = process.env.NIA_AUTH_BROWSER_TIMEOUT_MS;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.NIA_AUTH_BROWSER_TIMEOUT_MS;
		} else {
			process.env.NIA_AUTH_BROWSER_TIMEOUT_MS = original;
		}
	});

	test("uses default 10 minutes when unset", () => {
		delete process.env.NIA_AUTH_BROWSER_TIMEOUT_MS;
		expect(resolveBrowserAuthTimeoutMs()).toBe(10 * 60 * 1000);
	});

	test("parses NIA_AUTH_BROWSER_TIMEOUT_MS", () => {
		process.env.NIA_AUTH_BROWSER_TIMEOUT_MS = "5000";
		expect(resolveBrowserAuthTimeoutMs()).toBe(5000);
	});
});

describe("runBrowserDeviceLogin", () => {
	const originalFetch = globalThis.fetch;
	let openCalls = 0;

	beforeEach(() => {
		openCalls = 0;
		mock.module("open", () => ({
			default: mock(() => {
				openCalls++;
				return Promise.resolve();
			}),
		}));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	test("obtains API key after successful exchange", async () => {
		delete process.env.NIA_APP_URL;

		globalThis.fetch = mock(async (input: string | URL) => {
			const url = String(input);
			if (url.includes("/mcp-device/start")) {
				return new Response(
					JSON.stringify({
						authorization_session_id: "auth-1",
						user_code: "zzzz-yyyy",
						verification_url: "https://app.trynia.ai/cli-auth?foo=1",
						expires_at: new Date(Date.now() + 600_000).toISOString(),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/mcp-device/exchange")) {
				return new Response(JSON.stringify({ api_key: "nia_browser_ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const key = await runBrowserDeviceLogin();
		expect(key).toBe("nia_browser_ok");
		expect(openCalls).toBeGreaterThanOrEqual(1);
	});
});
