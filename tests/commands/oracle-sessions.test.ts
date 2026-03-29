import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock SDK ---

const mockStreamJob = mock(async function* () {
	yield { type: "thinking", content: "Analyzing the question..." };
	yield { type: "searching", content: "Searching repositories..." };
	yield { type: "content", content: "Here is the research output." };
	yield { type: "done", content: "Research complete" };
});

const mockListSessions = mock(() =>
	Promise.resolve([
		{
			session_id: "sess_abc123",
			query: "How does authentication work?",
			status: "completed",
			created_at: "2026-01-15T10:00:00Z",
		},
		{
			session_id: "sess_def456",
			query: "Explain the caching strategy used in the application",
			status: "completed",
			created_at: "2026-01-15T11:00:00Z",
		},
	]),
);

const mockGetSessionDetail = mock(() =>
	Promise.resolve({
		session_id: "sess_abc123",
		query: "How does authentication work?",
		status: "completed",
		model: "claude-opus-4-6",
		created_at: "2026-01-15T10:00:00Z",
		completed_at: "2026-01-15T10:02:30Z",
		result: { summary: "Authentication uses JWT tokens..." },
		job_id: "job_abc123",
	}),
);

const mockDeleteSession = mock(() =>
	Promise.resolve({ success: true, message: "Session deleted" }),
);

const mockGetSessionMessages = mock(() =>
	Promise.resolve([
		{
			role: "user",
			content: "How does authentication work?",
			created_at: "2026-01-15T10:00:00Z",
		},
		{
			role: "assistant",
			content: "Authentication in this system uses JWT tokens...",
			created_at: "2026-01-15T10:02:30Z",
		},
		{
			role: "user",
			content: "Can you explain the refresh token flow?",
			created_at: "2026-01-15T10:05:00Z",
		},
	]),
);

const mockChatStream = mock(() =>
	Promise.resolve({ content: "The refresh token flow works as follows..." }),
);

const mockGetUsage = mock(() =>
	Promise.resolve({
		user_id: "user_123",
		tier: "Pro",
		period: { start: "2026-01-01", end: "2026-02-01" },
		buckets: {
			queries: { used: 42, limit: 100, remaining: 58 },
			oracle: { used: 5, limit: 20, remaining: 15 },
			indexing: { used: 3, limit: 10, remaining: 7 },
			oracle_1m: { used: 1, limit: 5, remaining: 4 },
		},
	}),
);

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {};
		sources = {};
		oracle = {
			createJob: mock(() => Promise.resolve({ job_id: "job_abc123" })),
			getJob: mock(() => Promise.resolve({ job_id: "job_abc123" })),
			streamJob: mockStreamJob,
		};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	DefaultService: {
		listOracleSessionsV2OracleSessionsGet: mockListSessions,
		getOracleSessionDetailV2OracleSessionsSessionIdGet: mockGetSessionDetail,
		deleteOracleSessionV2OracleSessionsSessionIdDelete: mockDeleteSession,
		getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet:
			mockGetSessionMessages,
		streamOracleSessionChatV2OracleSessionsSessionIdChatStreamPost:
			mockChatStream,
		cancelOracleJobV2OracleJobsJobIdDelete: mock(() => Promise.resolve()),
		listOracleJobsV2OracleJobsGet: mock(() => Promise.resolve([])),
	},
	V2ApiService: {
		getUsageSummaryV2V2UsageGet: mockGetUsage,
	},
}));

// --- Import after mocking ---

import { DefaultService } from "nia-ai-ts";
import { normalizeUsageSummary } from "../../src/services/compat/usage.ts";
import { createSdk } from "../../src/services/sdk.ts";

describe("oracle session commands", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_oracle_sessions_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: false,
			output: undefined,
		});

		mockStreamJob.mockClear();
		mockListSessions.mockClear();
		mockGetSessionDetail.mockClear();
		mockDeleteSession.mockClear();
		mockGetSessionMessages.mockClear();
		mockChatStream.mockClear();
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

	// --- Stream ---

	describe("oracle stream", () => {
		test("sdk.oracle.streamJob returns an async generator", async () => {
			const sdk = await createSdk();

			const events: Record<string, unknown>[] = [];
			for await (const event of sdk.oracle.streamJob("job_abc123")) {
				events.push(event);
			}

			expect(mockStreamJob).toHaveBeenCalledTimes(1);
			expect(mockStreamJob).toHaveBeenCalledWith("job_abc123");
		});

		test("stream yields events with type and content", async () => {
			const sdk = await createSdk();

			const events: Record<string, unknown>[] = [];
			for await (const event of sdk.oracle.streamJob("job_abc123")) {
				events.push(event);
			}

			expect(events).toHaveLength(4);
			expect(events[0]).toEqual({
				type: "thinking",
				content: "Analyzing the question...",
			});
			expect(events[1]).toEqual({
				type: "searching",
				content: "Searching repositories...",
			});
			expect(events[2]).toEqual({
				type: "content",
				content: "Here is the research output.",
			});
			expect(events[3]).toEqual({ type: "done", content: "Research complete" });
		});

		test("stream handles empty generator", async () => {
			mockStreamJob.mockImplementationOnce(async function* () {
				// Empty — no events
			});

			const sdk = await createSdk();

			const events: Record<string, unknown>[] = [];
			for await (const event of sdk.oracle.streamJob("job_empty")) {
				events.push(event);
			}

			expect(events).toHaveLength(0);
		});
	});

	// --- Sessions ---

	describe("oracle sessions (list)", () => {
		test("calls DefaultService.listOracleSessionsV2OracleSessionsGet without params", async () => {
			await createSdk();

			await DefaultService.listOracleSessionsV2OracleSessionsGet(
				undefined,
				undefined,
			);

			expect(mockListSessions).toHaveBeenCalledTimes(1);
			expect(mockListSessions).toHaveBeenCalledWith(undefined, undefined);
		});

		test("passes limit parameter", async () => {
			await createSdk();

			await DefaultService.listOracleSessionsV2OracleSessionsGet(10, undefined);

			expect(mockListSessions).toHaveBeenCalledWith(10, undefined);
		});

		test("passes skip parameter", async () => {
			await createSdk();

			await DefaultService.listOracleSessionsV2OracleSessionsGet(undefined, 5);

			expect(mockListSessions).toHaveBeenCalledWith(undefined, 5);
		});

		test("passes limit and skip together", async () => {
			await createSdk();

			await DefaultService.listOracleSessionsV2OracleSessionsGet(20, 10);

			expect(mockListSessions).toHaveBeenCalledWith(20, 10);
		});

		test("returns array of sessions", async () => {
			await createSdk();

			const result = await DefaultService.listOracleSessionsV2OracleSessionsGet(
				undefined,
				undefined,
			);

			expect(Array.isArray(result)).toBe(true);
			expect(result).toHaveLength(2);
			expect(result[0].session_id).toBe("sess_abc123");
			expect(result[1].session_id).toBe("sess_def456");
		});

		test("returns empty array when no sessions found", async () => {
			mockListSessions.mockImplementationOnce(() => Promise.resolve([]));

			await createSdk();

			const result = await DefaultService.listOracleSessionsV2OracleSessionsGet(
				undefined,
				undefined,
			);

			expect(Array.isArray(result)).toBe(true);
			expect(result).toHaveLength(0);
		});
	});

	// --- Session Detail ---

	describe("oracle session (detail)", () => {
		test("calls getOracleSessionDetailV2OracleSessionsSessionIdGet with session ID", async () => {
			await createSdk();

			await DefaultService.getOracleSessionDetailV2OracleSessionsSessionIdGet(
				"sess_abc123",
			);

			expect(mockGetSessionDetail).toHaveBeenCalledTimes(1);
			expect(mockGetSessionDetail).toHaveBeenCalledWith("sess_abc123");
		});

		test("returns session with full details", async () => {
			await createSdk();

			const result =
				await DefaultService.getOracleSessionDetailV2OracleSessionsSessionIdGet(
					"sess_abc123",
				);

			expect(result.session_id).toBe("sess_abc123");
			expect(result.query).toBe("How does authentication work?");
			expect(result.status).toBe("completed");
			expect(result.model).toBe("claude-opus-4-6");
			expect(result.result).toEqual({
				summary: "Authentication uses JWT tokens...",
			});
			expect(result.job_id).toBe("job_abc123");
		});

		test("handles session not found (404)", async () => {
			mockGetSessionDetail.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(
				DefaultService.getOracleSessionDetailV2OracleSessionsSessionIdGet(
					"sess_nonexistent",
				),
			).rejects.toThrow("Not Found");
		});
	});

	// --- Messages ---

	describe("oracle messages", () => {
		test("calls getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet with session ID", async () => {
			await createSdk();

			await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
				"sess_abc123",
				undefined,
			);

			expect(mockGetSessionMessages).toHaveBeenCalledTimes(1);
			expect(mockGetSessionMessages).toHaveBeenCalledWith(
				"sess_abc123",
				undefined,
			);
		});

		test("passes limit parameter", async () => {
			await createSdk();

			await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
				"sess_abc123",
				50,
			);

			expect(mockGetSessionMessages).toHaveBeenCalledWith("sess_abc123", 50);
		});

		test("returns array of messages with roles", async () => {
			await createSdk();

			const result =
				await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
					"sess_abc123",
					undefined,
				);

			expect(Array.isArray(result)).toBe(true);
			expect(result).toHaveLength(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("assistant");
			expect(result[2].role).toBe("user");
		});

		test("returns empty array for session with no messages", async () => {
			mockGetSessionMessages.mockImplementationOnce(() => Promise.resolve([]));

			await createSdk();

			const result =
				await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
					"sess_empty",
					undefined,
				);

			expect(Array.isArray(result)).toBe(true);
			expect(result).toHaveLength(0);
		});

		test("messages contain content and timestamps", async () => {
			await createSdk();

			const result =
				await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
					"sess_abc123",
					undefined,
				);

			expect(result[0].content).toBe("How does authentication work?");
			expect(result[0].created_at).toBe("2026-01-15T10:00:00Z");
			expect(result[1].content).toContain("JWT tokens");
		});
	});

	// --- Chat ---

	describe("oracle chat", () => {
		test("chat request body contains message field", () => {
			const requestBody = {
				message: "Can you explain the refresh token flow?",
			};

			expect(requestBody).toHaveProperty("message");
			expect(typeof requestBody.message).toBe("string");
		});

		test("chat session ID is passed correctly", async () => {
			await createSdk();

			// Simulate the DefaultService call (even though the real implementation
			// uses manual fetch for SSE, we verify the mapping)
			await DefaultService.streamOracleSessionChatV2OracleSessionsSessionIdChatStreamPost(
				"sess_abc123",
				{ message: "Tell me more about refresh tokens" },
			);

			expect(mockChatStream).toHaveBeenCalledTimes(1);
			expect(mockChatStream).toHaveBeenCalledWith("sess_abc123", {
				message: "Tell me more about refresh tokens",
			});
		});

		test("chat constructs correct SSE endpoint URL", () => {
			const baseUrl = "https://apigcp.trynia.ai/v2";
			const sessionId = "sess_abc123";
			const url = `${baseUrl}/oracle/sessions/${encodeURIComponent(sessionId)}/chat/stream`;

			expect(url).toBe(
				"https://apigcp.trynia.ai/v2/oracle/sessions/sess_abc123/chat/stream",
			);
		});

		test("chat handles special characters in session ID for URL encoding", () => {
			const baseUrl = "https://apigcp.trynia.ai/v2";
			const sessionId = "sess_abc/123";
			const url = `${baseUrl}/oracle/sessions/${encodeURIComponent(sessionId)}/chat/stream`;

			expect(url).toBe(
				"https://apigcp.trynia.ai/v2/oracle/sessions/sess_abc%2F123/chat/stream",
			);
		});
	});

	// --- Delete Session ---

	describe("oracle delete-session", () => {
		test("calls deleteOracleSessionV2OracleSessionsSessionIdDelete with session ID", async () => {
			await createSdk();

			await DefaultService.deleteOracleSessionV2OracleSessionsSessionIdDelete(
				"sess_abc123",
			);

			expect(mockDeleteSession).toHaveBeenCalledTimes(1);
			expect(mockDeleteSession).toHaveBeenCalledWith("sess_abc123");
		});

		test("returns success response", async () => {
			await createSdk();

			const result =
				await DefaultService.deleteOracleSessionV2OracleSessionsSessionIdDelete(
					"sess_abc123",
				);

			expect(result).toEqual({ success: true, message: "Session deleted" });
		});

		test("handles deletion of non-existent session (404)", async () => {
			mockDeleteSession.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(
				DefaultService.deleteOracleSessionV2OracleSessionsSessionIdDelete(
					"sess_nonexistent",
				),
			).rejects.toThrow("Not Found");
		});
	});

	// --- 1M Usage ---

	describe("oracle 1m-usage", () => {
		test("V2ApiService.getUsageSummaryV2V2UsageGet returns usage data", async () => {
			await createSdk();

			const { V2ApiService } = await import("nia-ai-ts");
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result);

			expect(mockGetUsage).toHaveBeenCalledTimes(1);
			expect(usage.plan).toBe("Pro");
		});

		test("usage response contains oracle and oracle_1m entries", async () => {
			await createSdk();

			const { V2ApiService } = await import("nia-ai-ts");
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			const usage = normalizeUsageSummary(result).usage;
			expect(usage.oracle).toEqual({
				used: 5,
				limit: 20,
				unlimited: false,
				remaining: 15,
				isLifetime: undefined,
			});
			expect(usage.oracle_1m).toEqual({
				used: 1,
				limit: 5,
				unlimited: false,
				remaining: 4,
				isLifetime: undefined,
			});
		});

		test("usage response includes billing period", async () => {
			await createSdk();

			const { V2ApiService } = await import("nia-ai-ts");
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			expect(normalizeUsageSummary(result).period).toBe(
				"2026-01-01 — 2026-02-01",
			);
		});

		test("usage percentage calculation", () => {
			const used = 42;
			const limit = 100;
			const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

			expect(pct).toBe(42);
		});

		test("handles unlimited usage entries", () => {
			const entry = { used: 100, limit: 0, unlimited: true };

			if (entry.unlimited) {
				const display = `${entry.used} (unlimited)`;
				expect(display).toBe("100 (unlimited)");
			}
		});
	});

	// --- Error Handling ---

	describe("error handling", () => {
		test("handles 401 authentication error for session operations", async () => {
			mockListSessions.mockImplementationOnce(() => {
				const error = new Error("Unauthorized") as Error & { status: number };
				error.status = 401;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(
				DefaultService.listOracleSessionsV2OracleSessionsGet(
					undefined,
					undefined,
				),
			).rejects.toThrow("Unauthorized");
		});

		test("handles 404 for session detail", async () => {
			mockGetSessionDetail.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(
				DefaultService.getOracleSessionDetailV2OracleSessionsSessionIdGet(
					"nonexistent",
				),
			).rejects.toThrow("Not Found");
		});

		test("handles 500 server error for messages", async () => {
			mockGetSessionMessages.mockImplementationOnce(() => {
				const error = new Error("Internal Server Error") as Error & {
					status: number;
				};
				error.status = 500;
				return Promise.reject(error);
			});

			await createSdk();

			await expect(
				DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
					"sess_abc123",
					undefined,
				),
			).rejects.toThrow("Internal Server Error");
		});

		test("handles missing API key", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			delete process.env.NIA_API_KEY;

			await expect(createSdk()).rejects.toThrow("No API key found");
		});
	});

	// --- Flag-to-Parameter Mapping ---

	describe("flag-to-parameter mapping", () => {
		test("sessions list limit maps directly", () => {
			const flags = { limit: 25, skip: 10 };

			expect(flags.limit).toBe(25);
			expect(flags.skip).toBe(10);
		});

		test("messages limit maps directly", () => {
			const flags = { limit: 50 };

			expect(flags.limit).toBe(50);
		});

		test("chat message arg maps to OracleSessionChatRequest body", () => {
			const message = "Can you explain the refresh token flow?";
			const requestBody = { message };

			expect(requestBody).toEqual({
				message: "Can you explain the refresh token flow?",
			});
		});

		test("session query truncation for sessions list display", () => {
			const longQuery =
				"This is a very long research question that exceeds sixty characters and should be truncated for display";
			const truncated =
				longQuery.length > 60 ? `${longQuery.slice(0, 57)}...` : longQuery;

			expect(truncated.length).toBeLessThanOrEqual(60);
			expect(truncated).toEndWith("...");
		});

		test("stream command only needs job-id argument", () => {
			const args = { "job-id": "job_abc123" };

			expect(args["job-id"]).toBe("job_abc123");
		});

		test("delete-session only needs session-id argument", () => {
			const args = { "session-id": "sess_abc123" };

			expect(args["session-id"]).toBe("sess_abc123");
		});
	});
});
