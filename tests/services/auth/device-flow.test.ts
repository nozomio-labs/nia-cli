import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	type DeviceSession,
	exchangeForApiKey,
	isDeviceFlowError,
	resolveDeviceBackendUrl,
	startDeviceSession,
} from "../../../src/services/auth/device-flow.ts";

describe("device-flow", () => {
	const originalFetch = globalThis.fetch;
	const originalBackend = process.env.NIA_BACKEND_URL;
	const originalApp = process.env.NIA_APP_URL;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		process.env.NIA_BACKEND_URL = originalBackend;
		process.env.NIA_APP_URL = originalApp;
	});

	describe("resolveDeviceBackendUrl", () => {
		test("uses NIA_BACKEND_URL when set", () => {
			process.env.NIA_BACKEND_URL = "https://example.com/";
			expect(resolveDeviceBackendUrl()).toBe("https://example.com");
		});

		test("defaults to apigcp host", () => {
			delete process.env.NIA_BACKEND_URL;
			expect(resolveDeviceBackendUrl()).toBe("https://apigcp.trynia.ai");
		});
	});

	describe("startDeviceSession", () => {
		test("returns session with cli-onboarding verification URL", async () => {
			delete process.env.NIA_APP_URL;

			globalThis.fetch = mock(async (input: string | URL) => {
				const url = String(input);
				expect(url).toContain("/public/mcp-device/start");
				return new Response(
					JSON.stringify({
						authorization_session_id: "sid-1",
						user_code: "abcd-efgh",
						verification_url: "https://app.trynia.ai/cli-auth?x=1",
						expires_at: new Date(Date.now() + 600_000).toISOString(),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch;

			const session = await startDeviceSession();
			expect(session.authorization_session_id).toBe("sid-1");
			expect(session.user_code).toBe("abcd-efgh");
			expect(session.verification_url).toContain("/cli-onboarding?");
			expect(session.verification_url).not.toContain("/cli-auth?");
		});
	});

	describe("exchangeForApiKey", () => {
		const session: DeviceSession = {
			authorization_session_id: "s1",
			user_code: "code",
			verification_url: "https://app/x",
			expires_at: new Date(Date.now() + 600_000).toISOString(),
		};

		test("returns api_key on success", async () => {
			globalThis.fetch = mock(async (input: string | URL) => {
				const url = String(input);
				expect(url).toContain("/public/mcp-device/exchange");
				return new Response(JSON.stringify({ api_key: "nia_from_device_1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const key = await exchangeForApiKey(session);
			expect(key).toBe("nia_from_device_1");
		});

		test("maps pending authorization to not_ready", async () => {
			globalThis.fetch = mock(async () => {
				return new Response(JSON.stringify({ detail: "not yet authorized" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			try {
				await exchangeForApiKey(session);
				expect.unreachable();
			} catch (e) {
				expect(isDeviceFlowError(e)).toBe(true);
				if (isDeviceFlowError(e)) {
					expect(e.type).toBe("not_ready");
				}
			}
		});
	});
});
