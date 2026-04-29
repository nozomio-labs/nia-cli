import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock SDK ---

const mockGetUsage = mock(() =>
	Promise.resolve({
		user_id: "user_123",
		tier: "Pro",
		period: { start: "2026-01-01", end: "2026-02-01" },
		apiKeyId: "key_123",
		buckets: {
			queries: { used: 42, limit: 100, remaining: 58 },
			indexing: { used: 3, limit: 10, remaining: 7 },
			oracle: { used: 5, limit: 20, remaining: 15 },
			tracer: { used: 10, limit: "unlimited", remaining: "unlimited" },
		},
	}),
);

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {};
		sources = {};
		oracle = {
			createJob: mock(() => Promise.resolve({})),
			getJob: mock(() => Promise.resolve({})),
			streamJob: mock(async function* () {}),
		};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiService: {
		getUsageSummaryV2V2UsageGet: mockGetUsage,
	},
}));

// --- Import after mocking ---

import { V2ApiService } from "nia-ai-ts";
import {
	formatCliUsageLines,
	normalizeUsageSummary,
} from "../../src/services/compat/usage.ts";
import { createSdk } from "../../src/services/sdk.ts";

describe("usage command", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_usage_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: false,
			output: undefined,
		});

		mockGetUsage.mockClear();
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	// --- Usage API ---

	describe("nia usage", () => {
		test("V2ApiService.getUsageSummaryV2V2UsageGet is called", async () => {
			await createSdk();

			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();

			expect(mockGetUsage).toHaveBeenCalledTimes(1);
			expect(result).toBeDefined();
		});

		test("normalizes new usage response plan and period", async () => {
			await createSdk();

			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result);

			expect(usage.plan).toBe("Pro");
			expect(usage.period).toBe("2026-01-01 — 2026-02-01");
		});

		test("normalizes structured bucket usage entries", async () => {
			await createSdk();

			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result);

			expect(usage.usage.queries).toEqual({
				used: 42,
				limit: 100,
				unlimited: false,
				remaining: 58,
				isLifetime: undefined,
			});
			expect(usage.usage.tracer).toEqual({
				used: 10,
				limit: undefined,
				unlimited: true,
				remaining: "unlimited",
				isLifetime: undefined,
			});
		});

		test("formatCliUsageLines shows Balance and remaining/limit", async () => {
			await createSdk();

			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const lines = formatCliUsageLines(normalizeUsageSummary(result));

			expect(lines).toContain("\nBalance:");
			expect(lines).toContain("  queries: 58/100");
			expect(lines).toContain("  indexing: 7/10");
			expect(lines).toContain("  oracle: 15/20");
			expect(lines).toContain("  tracer: ∞");
		});

		test("normalizes purchased credits outside subscription usage", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock with partial response
			(mockGetUsage as any).mockImplementationOnce(() =>
				Promise.resolve({
					user_id: "user_123",
					tier: "Pro",
					period: { start: "2026-01-01", end: "2026-02-01" },
					buckets: {
						queries: { used: 42, limit: 100, remaining: 58 },
					},
					credits: 40,
				}),
			);

			await createSdk();
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result);

			expect(usage.credits).toBe(40);
		});

		test("formatCliUsageLines shows purchased credits separately", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock with partial response
			(mockGetUsage as any).mockImplementationOnce(() =>
				Promise.resolve({
					user_id: "user_123",
					tier: "Pro",
					period: { start: "2026-01-01", end: "2026-02-01" },
					buckets: {
						queries: { used: 42, limit: 100, remaining: 58 },
					},
					credits: 40,
				}),
			);

			await createSdk();
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const lines = formatCliUsageLines(normalizeUsageSummary(result));

			expect(lines).toContain("\nCredits:");
			expect(lines).toContain("  api_requests: 40");
		});

		test("computes remaining from used and limit when remaining omitted", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock with partial response
			(mockGetUsage as any).mockImplementationOnce(() =>
				Promise.resolve({
					user_id: "user_123",
					tier: "Free",
					period: { start: "2026-01-01", end: "2026-02-01" },
					buckets: {
						queries: { used: 2, limit: 10, unlimited: false },
					},
				}),
			);

			await createSdk();
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const lines = formatCliUsageLines(normalizeUsageSummary(result));

			expect(lines).toContain("  queries: 8/10");
		});

		test("handles empty usage breakdown", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock with partial response
			(mockGetUsage as any).mockImplementationOnce(() =>
				Promise.resolve({
					user_id: "user_123",
					tier: "Free",
					period: { start: "2026-01-01", end: "2026-02-01" },
					buckets: {},
				}),
			);

			await createSdk();
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result).usage;
			expect(Object.keys(usage).length).toBe(0);
		});

		test("handles old usage contract too", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock with partial response
			(mockGetUsage as any).mockImplementationOnce(() =>
				Promise.resolve({
					user_id: "user_123",
					subscription_tier: "Free",
					billing_period_start: "2026-01-01",
					billing_period_end: "2026-02-01",
					usage: {
						queries: { used: 2, limit: 10, unlimited: false },
					},
				}),
			);

			await createSdk();
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result);
			expect(usage.plan).toBe("Free");
			expect(usage.period).toBe("2026-01-01 — 2026-02-01");
			expect(usage.usage.queries).toEqual({
				used: 2,
				limit: 10,
				unlimited: false,
				remaining: undefined,
				isLifetime: undefined,
			});
		});
	});

	// --- Error Handling ---

	describe("error handling", () => {
		test("handles 401 authentication error", async () => {
			mockGetUsage.mockImplementationOnce(() => {
				const error = new Error("Unauthorized") as Error & { status: number };
				error.status = 401;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(V2ApiService.getUsageSummaryV2V2UsageGet()).rejects.toThrow(
				"Unauthorized",
			);
		});

		test("handles 429 rate limit error", async () => {
			mockGetUsage.mockImplementationOnce(() => {
				const error = new Error("Too Many Requests") as Error & {
					status: number;
				};
				error.status = 429;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(V2ApiService.getUsageSummaryV2V2UsageGet()).rejects.toThrow(
				"Too Many Requests",
			);
		});

		test("handles 500 server error", async () => {
			mockGetUsage.mockImplementationOnce(() => {
				const error = new Error("Internal Server Error") as Error & {
					status: number;
				};
				error.status = 500;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(V2ApiService.getUsageSummaryV2V2UsageGet()).rejects.toThrow(
				"Internal Server Error",
			);
		});

		test("error status code mapping", () => {
			const statusMessages: Record<number, string> = {
				401: "Authentication failed",
				403: "Authentication failed",
				429: "Rate limited",
				500: "Server error",
			};

			expect(statusMessages[401]).toBe("Authentication failed");
			expect(statusMessages[429]).toBe("Rate limited");
			expect(statusMessages[500]).toBe("Server error");
		});
	});
});
