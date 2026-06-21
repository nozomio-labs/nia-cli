import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWithOptions } from "node:util";
import { MANIFEST_FILENAME } from "../../src/services/project.ts";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

const originalFetch = globalThis.fetch;
type FetchMock = (
	...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;
const mockFetch = mock<FetchMock>(
	(..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> =>
		Promise.resolve(createSseResponse([])),
);

function createSseResponse(events: Record<string, unknown>[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			}
			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
		},
	});
}

function normalizeOutputChunk(chunk: unknown): string {
	if (typeof chunk === "string") {
		return chunk;
	}

	if (chunk instanceof Uint8Array) {
		return new TextDecoder().decode(chunk);
	}

	return String(chunk);
}

async function captureCommandOutput(
	run: () => Promise<void>,
	options: { stdoutTTY?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const originalStdoutTTY = process.stdout.isTTY;

	Object.defineProperty(process.stdout, "isTTY", {
		value: options.stdoutTTY ?? true,
		configurable: true,
	});

	console.log = ((...args: unknown[]) => {
		stdout.push(`${formatWithOptions({ colors: false }, ...args)}\n`);
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		stderr.push(`${formatWithOptions({ colors: false }, ...args)}\n`);
	}) as typeof console.error;
	process.stdout.write = ((chunk: unknown) => {
		stdout.push(normalizeOutputChunk(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr.push(normalizeOutputChunk(chunk));
		return true;
	}) as typeof process.stderr.write;

	try {
		await run();
	} finally {
		console.log = originalLog;
		console.error = originalError;
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		Object.defineProperty(process.stdout, "isTTY", {
			value: originalStdoutTTY,
			configurable: true,
		});
	}

	return {
		stdout: stdout.join(""),
		stderr: stderr.join(""),
	};
}

// --- Mock SDK ---

const mockUniversal = mock(() =>
	Promise.resolve({
		results: [] as Record<string, unknown>[],
		total: 0,
	}),
);
const mockQuery = mock(() =>
	Promise.resolve({
		answer: "test answer",
		sources: [] as Record<string, unknown>[],
		citations: [] as Record<string, unknown>[],
	}),
);
const mockWeb = mock(() =>
	Promise.resolve({
		github_repos: [] as Record<string, unknown>[],
		documentation: [] as Record<string, unknown>[],
		other_content: [] as Record<string, unknown>[],
		total_results: 0,
	}),
);
const mockDeep = mock(() =>
	Promise.resolve({
		data: { summary: "deep result" } as Record<string, unknown>,
		status: "completed",
	}),
);
const mockExperimentalSearchPost = mock(() =>
	Promise.resolve({
		data: {
			mode: "query",
			execution: "snippet_search",
			query: "How does auth work?",
			content: "Found relevant indexed matches.",
			sources: [] as Record<string, unknown>[],
			followUpQuestions: [] as string[],
			readySources: [] as Record<string, unknown>[],
			blockedSources: [] as Record<string, unknown>[],
		},
		error: null,
		status: 200,
	}),
);

const mockSandboxSearchPost = mock((body: Record<string, unknown>) =>
	Promise.resolve({
		data: {
			workspaceKind: "git_repository",
			job: {
				id: "sandbox-job-1",
				status: "completed",
				query: body.query,
				createdAt: new Date(),
				completedAt: new Date(),
			},
			result: {
				answer: "Sandbox agent answer",
				rawOutput: "",
				command: "opencode",
				exitCode: 0,
				workspacePath: "/workspace",
				volumeName: null,
				cacheSubpath: null,
			},
		},
		error: null,
		status: 200,
	}),
);

const mockSandboxJobGet = mock((params: { jobId: string }) =>
	Promise.resolve({
		data: {
			workspaceKind: "git_repository",
			job: {
				id: params.jobId,
				status: "completed",
				query: "prior query",
				createdAt: new Date(),
				completedAt: new Date(),
			},
			result: {
				answer: "Job fetch answer",
				rawOutput: "",
				command: "opencode",
				exitCode: 0,
				workspacePath: "/workspace",
				volumeName: null,
				cacheSubpath: null,
			},
		},
		error: null,
		status: 200,
	}),
);

mock.module("@nozomioai/nia-sdk", () => ({
	createClient: mock(() => ({
		usage: {
			get: mock(() => Promise.resolve({ data: {}, error: null, status: 200 })),
		},
		search: {
			post: mockExperimentalSearchPost,
		},
		sandbox: {
			search: {
				post: mockSandboxSearchPost,
			},
			jobs: (params: { jobId: string }) => ({
				get: () => mockSandboxJobGet(params),
			}),
		},
		sources: Object.assign(
			() => ({
				get: mock(() =>
					Promise.resolve({ data: {}, error: null, status: 200 }),
				),
				patch: mock(() =>
					Promise.resolve({ data: {}, error: null, status: 200 }),
				),
				delete: mock(() =>
					Promise.resolve({ data: {}, error: null, status: 200 }),
				),
				tree: {
					get: mock(() =>
						Promise.resolve({ data: {}, error: null, status: 200 }),
					),
				},
				content: {
					get: mock(() =>
						Promise.resolve({ data: {}, error: null, status: 200 }),
					),
				},
				grep: {
					post: mock(() =>
						Promise.resolve({ data: {}, error: null, status: 200 }),
					),
				},
			}),
			{
				get: mock(() =>
					Promise.resolve({ data: { items: [] }, error: null, status: 200 }),
				),
				post: mock(() =>
					Promise.resolve({ data: {}, error: null, status: 200 }),
				),
				resolve: {
					get: mock(() =>
						Promise.resolve({ data: { items: [] }, error: null, status: 200 }),
					),
				},
			},
		),
	})),
}));

mock.module("nia-ai-ts", () => ({
	ApiError: class extends Error {
		status: number;
		body?: unknown;
		constructor(
			_request?: unknown,
			response?: { status?: number; body?: unknown },
			message?: string,
		) {
			super(message ?? "ApiError");
			this.name = "ApiError";
			this.status = response?.status ?? 500;
			this.body = response?.body;
		}
	},
	NiaSDK: class {
		search = {
			universal: mockUniversal,
			query: mockQuery,
			web: mockWeb,
			deep: mockDeep,
		};
		sources = {};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	NiaSDKError: class extends Error {},
	NiaTimeoutError: class extends Error {},
	V2ApiService: {
		getUsageSummaryV2V2UsageGet: mock(() => Promise.resolve({})),
	},
	V2ApiDataSourcesService: {
		readDocumentationFileV2V2DataSourcesSourceIdReadGet: mock(() =>
			Promise.resolve({}),
		),
		grepDocumentationV2V2DataSourcesSourceIdGrepPost: mock(() =>
			Promise.resolve({}),
		),
		getDocumentationTreeV2V2DataSourcesSourceIdTreeGet: mock(() =>
			Promise.resolve({}),
		),
	},
	V2ApiSourcesService: {
		getSourceV2SourcesSourceIdGet: mock(() => Promise.resolve({})),
		updateSourceV2SourcesSourceIdPatch: mock(() => Promise.resolve({})),
		deleteSourceV2SourcesSourceIdDelete: mock(() => Promise.resolve({})),
	},
}));

// --- Import after mocking ---

describe("search commands", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		// Set up a valid API key in config for SDK creation
		await writeConfig({
			apiKey: "nia_test_search_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		mockUniversal.mockClear();
		mockQuery.mockClear();
		mockWeb.mockClear();
		mockDeep.mockClear();
		mockExperimentalSearchPost.mockClear();
		mockSandboxSearchPost.mockClear();
		mockSandboxJobGet.mockClear();
		mockFetch.mockReset();
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				createSseResponse([
					{ type: "job", jobId: "sandbox-job-stream" },
					{
						type: "status",
						jobStatus: "running",
						runtimeStatus: "ready",
					},
					{
						type: "opencode",
						event: {
							type: "step_start",
							part: { type: "step-start" },
						},
					},
					{
						type: "opencode",
						event: {
							type: "tool_use",
							part: {
								tool: "read",
								state: {
									status: "completed",
									title: "Read src/middleware/auth.ts",
									metadata: { exit: 0 },
								},
							},
						},
					},
					{
						type: "opencode",
						event: {
							type: "step_finish",
							part: { reason: "tool-calls" },
						},
					},
					{
						type: "opencode",
						event: {
							type: "text",
							part: { text: "Sandbox stream answer" },
						},
					},
					{
						type: "opencode",
						event: {
							type: "step_finish",
							part: { reason: "stop" },
						},
					},
					{
						type: "result",
						jobId: "sandbox-job-stream",
						payload: {
							workspaceKind: "git_repository",
							job: {
								id: "sandbox-job-stream",
								status: "completed",
								query: "Where is the auth middleware?",
							},
							result: {
								answer: "Sandbox stream answer",
							},
						},
					},
					{ type: "done" },
				]),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		globalThis.fetch = originalFetch;
	});

	afterAll(() => {
		mock.restore();
	});

	describe("universal search", () => {
		test("calls sdk.search.universal with query", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.universal({ query: "test query" });

			expect(mockUniversal).toHaveBeenCalledTimes(1);
			expect(mockUniversal).toHaveBeenCalledWith({ query: "test query" });
		});

		test("passes top_k parameter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.universal({ query: "test", top_k: 20 });

			expect(mockUniversal).toHaveBeenCalledWith({ query: "test", top_k: 20 });
		});

		test("passes include_repos and include_docs flags", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.universal({
				query: "test",
				include_repos: true,
				include_docs: false,
			});

			expect(mockUniversal).toHaveBeenCalledWith({
				query: "test",
				include_repos: true,
				include_docs: false,
			});
		});

		test("returns search results", async () => {
			mockUniversal.mockImplementationOnce(() =>
				Promise.resolve({
					results: [{ title: "Result 1", score: 0.95 }],
					total: 1,
				}),
			);

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();
			const result = await sdk.search.universal({ query: "test" });

			expect(result.results).toHaveLength(1);
			expect(result.results[0].title).toBe("Result 1");
			expect(result.total).toBe(1);
		});
	});

	describe("query search", () => {
		test("builds experimental query payload from scoped flags", async () => {
			const { buildExperimentalQuerySearchPayload } = await import(
				"../../src/commands/search.ts"
			);

			expect(
				buildExperimentalQuerySearchPayload({
					query: "How does auth work?",
					repos: "vercel/ai",
					docs: "react-docs",
					localFolders: "vault-1",
				}),
			).toEqual({
				mode: "query",
				messages: [{ role: "user", content: "How does auth work?" }],
				sources: [
					{ identifier: "vercel/ai", type: "repository" },
					{ identifier: "react-docs", type: "documentation" },
					{ identifier: "vault-1", type: "local_folder" },
				],
			});
		});

		test("calls sdk.search.query with messages array", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "How does auth work?" }],
			});

			expect(mockQuery).toHaveBeenCalledTimes(1);
			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "How does auth work?" }],
			});
		});

		test("passes repositories and data_sources", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "test" }],
				repositories: ["vercel/ai", "openai/openai-node"],
				data_sources: ["react-docs"],
			});

			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "test" }],
				repositories: ["vercel/ai", "openai/openai-node"],
				data_sources: ["react-docs"],
			});
		});

		test("passes local_folders and category", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "test" }],
				local_folders: ["vault", "src-123"],
				category: "Work",
			});

			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "test" }],
				local_folders: ["vault", "src-123"],
				category: "Work",
			});
		});

		test("passes search_mode parameter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "test" }],
				search_mode: "repositories",
			});

			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "test" }],
				search_mode: "repositories",
			});
		});

		test("passes fast_mode and skip_llm flags", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "test" }],
				fast_mode: true,
				skip_llm: true,
			});

			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "test" }],
				fast_mode: true,
				skip_llm: true,
			});
		});

		test("passes max_tokens and reasoning_strategy", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.query({
				messages: [{ role: "user", content: "test" }],
				max_tokens: 2000,
				reasoning_strategy: "hybrid",
			});

			expect(mockQuery).toHaveBeenCalledWith({
				messages: [{ role: "user", content: "test" }],
				max_tokens: 2000,
				reasoning_strategy: "hybrid",
			});
		});

		test("executes experimental query mode with the new backend payload", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: true,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			try {
				await searchCommand.execute({
					argv: ["query", "How does auth work?", "--docs", "react-docs"],
				});

				expect(mockExperimentalSearchPost).toHaveBeenCalledWith({
					mode: "query",
					messages: [{ role: "user", content: "How does auth work?" }],
					sources: [{ identifier: "react-docs", type: "documentation" }],
				});
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});

		// Regression: the auto-scope status line is a diagnostic and must land on
		// stderr, never stdout, so that `nia search query --json | jq` stays
		// parseable even when a `nia.json` manifest triggers the scope hint. This
		// exercises the renderer-level routing (`fmt.info` -> stderr) end to end.
		test("--json keeps the auto-scope hint off stdout so the payload stays parseable", async () => {
			const manifestDir = mkdtempSync(path.join(os.tmpdir(), "nia-scope-"));
			writeFileSync(
				path.join(manifestDir, MANIFEST_FILENAME),
				JSON.stringify({
					version: 1,
					sources: ["vercel/next.js"],
					vaults: [],
					local: [],
				}),
				"utf8",
			);

			const originalCwd = process.cwd();
			process.chdir(manifestDir);

			try {
				const { searchCommand } = await import("../../src/commands/search.ts");
				const { stdout, stderr } = await captureCommandOutput(() =>
					searchCommand.execute({
						argv: ["query", "How does auth work?", "--json"],
					}),
				);

				const parsed = JSON.parse(stdout);
				expect(parsed.answer).toBe("test answer");
				expect(stdout).not.toContain("Using nia.json scope");
				expect(stderr).toContain("Using nia.json scope");
			} finally {
				process.chdir(originalCwd);
				rmSync(manifestDir, { recursive: true, force: true });
			}
		});
	});

	describe("sandbox search", () => {
		test("streams structured opencode activity by default in TTY", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(() =>
				searchCommand.execute({
					argv: [
						"sandbox",
						"-r",
						"https://github.com/acme/widget",
						"Where is the auth middleware?",
					],
				}),
			);
			const plainStdout = Bun.stripANSI(stdout);

			expect(stderr).toBe("");
			expect(mockSandboxSearchPost).not.toHaveBeenCalled();
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.trynia.ai/sandbox/search",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer nia_test_search_key",
						Accept: "text/event-stream",
						"Content-Type": "application/json",
					}),
				}),
			);
			expect(
				JSON.parse(
					String(
						(mockFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body,
					),
				),
			).toEqual({
				repository: "https://github.com/acme/widget",
				query: "Where is the auth middleware?",
				stream: true,
			});
			expect(plainStdout).toContain("Tool read: Read src/middleware/auth.ts");
			expect(plainStdout).toContain("Sandbox stream answer");
			expect(plainStdout.match(/Sandbox stream answer/g)?.length ?? 0).toBe(1);
			expect(plainStdout).not.toContain("Step started.");
			expect(plainStdout).not.toContain("Step finished:");
			expect(plainStdout).not.toContain("Sandbox job:");
			expect(plainStdout).not.toContain("Status: running");
			expect(plainStdout).not.toContain("workspaceKind");
		});

		test("routes --json to the non-streaming path and emits a single JSON object", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(() =>
				searchCommand.execute({
					argv: [
						"sandbox",
						"--json",
						"-r",
						"https://github.com/acme/widget",
						"Where is the auth middleware?",
					],
				}),
			);
			const plainStdout = Bun.stripANSI(stdout);

			// A machine format must bypass the SSE stream and use the
			// non-streaming eden path, so stdout is a single parseable payload
			// with no interleaved progress activity.
			expect(stderr).toBe("");
			expect(mockFetch).not.toHaveBeenCalled();
			expect(mockSandboxSearchPost).toHaveBeenCalledTimes(1);
			expect(plainStdout).not.toContain("Tool read");
			const parsed = JSON.parse(plainStdout);
			expect(parsed.result.answer).toBe("Sandbox agent answer");
		});

		test("passes optional ref to streamed sandbox search", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			try {
				await searchCommand.execute({
					argv: [
						"sandbox",
						"-r",
						"https://github.com/acme/widget",
						"--ref",
						"v1.0.0",
						"Explain the release process",
					],
				});

				expect(mockSandboxSearchPost).not.toHaveBeenCalled();
				expect(
					JSON.parse(
						String(
							(mockFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body,
						),
					),
				).toEqual({
					repository: "https://github.com/acme/widget",
					query: "Explain the release process",
					ref: "v1.0.0",
					stream: true,
				});
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});

		test("passes shorthand repository and provider to streamed sandbox search", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			try {
				await searchCommand.execute({
					argv: [
						"sandbox",
						"-r",
						"gitlabhq/gitlabhq",
						"--provider",
						"gitlab",
						"Explain the release process",
					],
				});

				expect(mockSandboxSearchPost).not.toHaveBeenCalled();
				expect(
					JSON.parse(
						String(
							(mockFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body,
						),
					),
				).toEqual({
					repository: "gitlabhq/gitlabhq",
					query: "Explain the release process",
					provider: "gitlab",
					stream: true,
				});
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});

		test("shows detailed streamed sandbox progress under --verbose", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			mockFetch.mockImplementationOnce(() =>
				Promise.resolve(
					createSseResponse([
						{ type: "job", jobId: "sandbox-job-stream" },
						{
							type: "status",
							jobStatus: "running",
							runtimeStatus: "ready",
						},
						{
							type: "opencode",
							event: {
								type: "tool_use",
								part: {
									tool: "bash",
									state: {
										status: "completed",
										title: "Inspect auth files",
										input: {
											command: "rg auth src tests",
										},
										metadata: { exit: 0 },
									},
								},
							},
						},
						{
							type: "opencode",
							event: {
								type: "text",
								part: { text: "Sandbox stream answer" },
							},
						},
						{
							type: "result",
							jobId: "sandbox-job-stream",
							payload: {
								workspaceKind: "git_repository",
								job: {
									id: "sandbox-job-stream",
									status: "completed",
									query: "Where is the auth middleware?",
								},
								result: {
									answer: "Sandbox stream answer",
									rawOutput:
										'{"type":"tool_use","part":{"tool":"bash","state":{"title":"Inspect auth files"}}}\n{"type":"text","text":"Sandbox stream answer"}',
								},
							},
						},
						{ type: "done" },
					]),
				),
			);

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(() =>
				searchCommand.execute({
					argv: [
						"sandbox",
						"--verbose",
						"-r",
						"https://github.com/acme/widget",
						"Where is the auth middleware?",
					],
				}),
			);
			const plainStdout = Bun.stripANSI(stdout);

			expect(stderr).toBe("");
			expect(plainStdout).toContain("Sandbox job: sandbox-job-stream");
			expect(plainStdout).toContain("Status: running");
			expect(plainStdout).toContain("Tool bash: Inspect auth files");
			expect(plainStdout).toContain("workspaceKind");
			expect(plainStdout).toContain("Sandbox stream answer");
			expect(plainStdout).not.toContain("rawOutput");
		});

		test("uses --no-stream to keep the JSON sandbox search path", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(() =>
				searchCommand.execute({
					argv: [
						"sandbox",
						"--no-stream",
						"-r",
						"workspace/widget",
						"--provider",
						"bitbucket",
						"--ref",
						"v1.0.0",
						"Explain the release process",
					],
				}),
			);
			const plainStdout = Bun.stripANSI(stdout);

			expect(stderr).toBe("");
			expect(mockFetch).not.toHaveBeenCalled();
			expect(mockSandboxSearchPost).toHaveBeenCalledWith({
				repository: "workspace/widget",
				query: "Explain the release process",
				provider: "bitbucket",
				ref: "v1.0.0",
			});
			expect(plainStdout).toContain("Sandbox agent answer");
			expect(plainStdout).not.toContain("workspacePath");
			expect(plainStdout).not.toContain("rawOutput");
		});

		test("sanitizes --no-stream sandbox output when stdout is not a TTY", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});
			mockSandboxSearchPost.mockImplementationOnce(() =>
				Promise.resolve({
					data: {
						workspaceKind: "git_repository",
						job: {
							id: "sandbox-job-nostream",
							status: "completed",
							query: "Explain the release process",
							createdAt: new Date(),
							completedAt: new Date(),
						},
						result: {
							answer:
								'stty -echo; printf hello\n{"type":"text","text":"Clean answer"}\n__NIA_PTY_EXIT__:0',
							rawOutput:
								'stty -echo; printf hello\n{"type":"text","text":"Clean answer"}\n__NIA_PTY_EXIT__:0',
							command: "opencode",
							exitCode: 0,
							workspacePath: "/workspace",
							volumeName: null,
							cacheSubpath: null,
						},
					},
					error: null,
					status: 200,
				}),
			);

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(
				() =>
					searchCommand.execute({
						argv: [
							"sandbox",
							"--no-stream",
							"-r",
							"https://github.com/acme/widget",
							"Explain the release process",
						],
					}),
				{ stdoutTTY: false },
			);

			expect(stderr).toBe("");
			expect(stdout).toContain("Clean answer");
			expect(stdout).not.toContain("rawOutput");
			expect(stdout).not.toContain("stty -echo");
			expect(stdout).not.toContain("__NIA_PTY_EXIT__");
		});

		test("keeps sandbox streaming output as JSON lines when stdout is not a TTY", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve(
					createSseResponse([
						{ type: "job", jobId: "sandbox-job-stream" },
						{
							type: "status",
							jobStatus: "running",
							runtimeStatus: "ready",
						},
						{
							type: "opencode",
							stream: "stdout",
							line: "stty -echo; printf '%s' 'abc' | base64 -d > /tmp/opencode.json",
						},
						{
							type: "opencode",
							stream: "stdout",
							line: "INFO  2026-04-05T00:28:25 +8ms service=models.dev file={} refreshing",
						},
						{
							type: "opencode",
							stream: "stdout",
							line: '{"type":"step_start"}',
							event: { type: "step_start" },
						},
						{
							type: "opencode",
							stream: "stdout",
							line: '{"type":"tool_use"}',
							event: {
								type: "tool_use",
								part: {
									tool: "read",
									state: {
										status: "completed",
										input: { filePath: "/workspace/AGENTS.md" },
									},
								},
							},
						},
						{
							type: "opencode",
							stream: "stdout",
							line: '{"type":"text","text":"Sandbox stream answer"}',
							event: { type: "text", text: "Sandbox stream answer" },
						},
						{
							type: "result",
							jobId: "sandbox-job-stream",
							payload: {
								workspaceKind: "git_repository",
								result: {
									answer:
										'{"type":"tool_use","part":{"tool":"read"}}\n{"type":"text","text":"Sandbox stream answer"}\n__NIA_PTY_EXIT__:0',
									rawOutput:
										'stty -echo; printf hello\n{"type":"text","text":"Sandbox stream answer"}\n__NIA_PTY_EXIT__:0',
								},
							},
						},
						{ type: "done" },
					]),
				),
			);

			const { searchCommand } = await import("../../src/commands/search.ts");
			const { stdout, stderr } = await captureCommandOutput(
				() =>
					searchCommand.execute({
						argv: [
							"sandbox",
							"-r",
							"https://github.com/acme/widget",
							"Where is the auth middleware?",
						],
					}),
				{ stdoutTTY: false },
			);
			const events = stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>);

			expect(stderr).toBe("");
			expect(events.map((event) => event.type)).toEqual([
				"job",
				"status",
				"opencode",
				"opencode",
				"result",
				"done",
			]);
			expect(events[2]).toEqual({
				type: "opencode",
				stream: "stdout",
				event: {
					type: "tool_use",
					tool: "read",
					summary: "Tool read: /workspace/AGENTS.md",
				},
			});
			expect(events[3]).toEqual({
				type: "opencode",
				stream: "stdout",
				event: {
					type: "text",
					text: "Sandbox stream answer",
				},
			});
			expect(events[4]).toEqual({
				type: "result",
				jobId: "sandbox-job-stream",
				payload: {
					workspaceKind: "git_repository",
					result: {
						answer: "Sandbox stream answer",
					},
				},
			});
			expect(stdout).not.toContain("Step started.");
			expect(stdout).not.toContain("stty -echo");
			expect(stdout).not.toContain("INFO  2026-04-05");
			expect(stdout).not.toContain("rawOutput");
		});

		test("fetches a sandbox job by id under sandbox job", async () => {
			await writeConfig({
				apiKey: "nia_test_search_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const { searchCommand } = await import("../../src/commands/search.ts");
			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			try {
				await searchCommand.execute({
					argv: ["sandbox", "job", "550e8400-e29b-41d4-a716-446655440000"],
				});

				expect(mockSandboxJobGet).toHaveBeenCalledWith({
					jobId: "550e8400-e29b-41d4-a716-446655440000",
				});
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});
	});

	describe("web search", () => {
		test("calls sdk.search.web with query", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.web({ query: "TypeScript best practices" });

			expect(mockWeb).toHaveBeenCalledTimes(1);
			expect(mockWeb).toHaveBeenCalledWith({
				query: "TypeScript best practices",
			});
		});

		test("passes num_results parameter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.web({ query: "test", num_results: 5 });

			expect(mockWeb).toHaveBeenCalledWith({ query: "test", num_results: 5 });
		});

		test("passes category filter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.web({ query: "test", category: "github" });

			expect(mockWeb).toHaveBeenCalledWith({
				query: "test",
				category: "github",
			});
		});

		test("passes days_back filter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.web({ query: "test", days_back: 30 });

			expect(mockWeb).toHaveBeenCalledWith({ query: "test", days_back: 30 });
		});

		test("returns structured web results", async () => {
			mockWeb.mockImplementationOnce(() =>
				Promise.resolve({
					github_repos: [
						{
							url: "https://github.com/test/repo",
							owner_repo: "test/repo",
							title: "Test Repo",
						},
					],
					documentation: [
						{
							url: "https://docs.test.com",
							title: "Test Docs",
						},
					],
					other_content: [],
					total_results: 2,
				}),
			);

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();
			const result = await sdk.search.web({ query: "test" });

			expect(result.github_repos).toHaveLength(1);
			expect(result.documentation).toHaveLength(1);
			expect(result.total_results).toBe(2);
		});

		test("validates category against allowed values", () => {
			const validCategories = [
				"github",
				"company",
				"research",
				"news",
				"tweet",
				"pdf",
				"blog",
			];

			for (const cat of validCategories) {
				expect(validCategories.includes(cat)).toBe(true);
			}

			expect(validCategories.includes("invalid")).toBe(false);
		});
	});

	describe("search mode resolution", () => {
		test("uses explicit mode when provided", async () => {
			const { resolveQuerySearchMode } = await import(
				"../../src/commands/search.ts"
			);
			expect(
				resolveQuerySearchMode({
					explicit: "repositories",
					repos: "vercel/ai",
					docs: "react-docs",
				}),
			).toBe("repositories");
		});

		test("returns repositories for repos-only queries", async () => {
			const { resolveQuerySearchMode } = await import(
				"../../src/commands/search.ts"
			);
			expect(resolveQuerySearchMode({ repos: "vercel/ai" })).toBe(
				"repositories",
			);
		});

		test("returns sources for docs-only queries", async () => {
			const { resolveQuerySearchMode } = await import(
				"../../src/commands/search.ts"
			);
			expect(resolveQuerySearchMode({ docs: "react-docs" })).toBe("sources");
		});

		test("returns sources for local-folder-only queries", async () => {
			const { resolveQuerySearchMode } = await import(
				"../../src/commands/search.ts"
			);
			expect(resolveQuerySearchMode({ localFolders: "vault" })).toBe("sources");
		});

		test("returns unified for mixed scopes", async () => {
			const { resolveQuerySearchMode } = await import(
				"../../src/commands/search.ts"
			);
			expect(
				resolveQuerySearchMode({
					repos: "vercel/ai",
					localFolders: "vault",
				}),
			).toBe("unified");
		});
	});

	describe("deep search", () => {
		test("calls sdk.search.deep with query", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.deep({ query: "What are LLM optimization techniques?" });

			expect(mockDeep).toHaveBeenCalledTimes(1);
			expect(mockDeep).toHaveBeenCalledWith({
				query: "What are LLM optimization techniques?",
			});
		});

		test("passes output_format parameter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.deep({ query: "test", output_format: "bullet_points" });

			expect(mockDeep).toHaveBeenCalledWith({
				query: "test",
				output_format: "bullet_points",
			});
		});

		test("passes verbose parameter", async () => {
			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await sdk.search.deep({ query: "test", verbose: true });

			expect(mockDeep).toHaveBeenCalledWith({ query: "test", verbose: true });
		});

		test("returns deep research results", async () => {
			mockDeep.mockImplementationOnce(() =>
				Promise.resolve({
					data: {
						summary: "Detailed analysis...",
						key_findings: ["a", "b", "c"],
					},
					status: "completed",
					citations: null,
				}),
			);

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();
			const result = await sdk.search.deep({ query: "test" });

			expect(result.data.summary).toBe("Detailed analysis...");
			expect(result.data.key_findings).toHaveLength(3);
			expect(result.status).toBe("completed");
		});
	});

	describe("error handling", () => {
		test("handles 401 authentication error", async () => {
			mockUniversal.mockImplementationOnce(() => {
				const error = new Error("Unauthorized") as Error & { status: number };
				error.status = 401;
				return Promise.reject(error);
			});

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await expect(sdk.search.universal({ query: "test" })).rejects.toThrow(
				"Unauthorized",
			);
		});

		test("handles 429 rate limit error", async () => {
			mockWeb.mockImplementationOnce(() => {
				const error = new Error("Rate Limited") as Error & { status: number };
				error.status = 429;
				return Promise.reject(error);
			});

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await expect(sdk.search.web({ query: "test" })).rejects.toThrow(
				"Rate Limited",
			);
		});

		test("handles 500 server error", async () => {
			mockDeep.mockImplementationOnce(() => {
				const error = new Error("Internal Server Error") as Error & {
					status: number;
				};
				error.status = 500;
				return Promise.reject(error);
			});

			const { createSdk } = await import("../../src/services/sdk.ts");
			const sdk = await createSdk();

			await expect(sdk.search.deep({ query: "test" })).rejects.toThrow(
				"Internal Server Error",
			);
		});

		test("handles missing API key error", async () => {
			// Reset config to remove API key
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://apigcp.trynia.ai/v2",
				output: undefined,
			});

			// Also ensure no env var
			delete process.env.NIA_API_KEY;

			const { createSdk } = await import("../../src/services/sdk.ts");

			await expect(createSdk()).rejects.toThrow("No API key found");
		});
	});

	describe("flag-to-parameter mapping", () => {
		test("repos flag splits into repositories array", () => {
			const reposFlag =
				"vercel/ai, openai/openai-node, langchain-ai/langchainjs";
			const repositories = reposFlag.split(",").map((s) => s.trim());

			expect(repositories).toEqual([
				"vercel/ai",
				"openai/openai-node",
				"langchain-ai/langchainjs",
			]);
		});

		test("docs flag splits into data_sources array", () => {
			const docsFlag = "react-docs,nextjs-docs";
			const dataSources = docsFlag.split(",").map((s) => s.trim());

			expect(dataSources).toEqual(["react-docs", "nextjs-docs"]);
		});

		test("query argument wraps into messages array", () => {
			const query = "How does authentication work?";
			const messages = [{ role: "user", content: query }];

			expect(messages).toEqual([
				{ role: "user", content: "How does authentication work?" },
			]);
		});

		test("search-mode maps to search_mode", () => {
			const params: Record<string, unknown> = {};
			const searchMode = "repositories";
			params.search_mode = searchMode;

			expect(params.search_mode).toBe("repositories");
		});

		test("fast flag maps to fast_mode", () => {
			const params: Record<string, unknown> = {};
			params.fast_mode = true;

			expect(params.fast_mode).toBe(true);
		});

		test("strategy flag maps to reasoning_strategy", () => {
			const params: Record<string, unknown> = {};
			params.reasoning_strategy = "hybrid";

			expect(params.reasoning_strategy).toBe("hybrid");
		});
	});
});
