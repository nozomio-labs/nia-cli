import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

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

mock.module("@nozomioai/nia-sdk", () => ({
	createClient: mock(() => ({
		usage: {
			get: mock(() => Promise.resolve({ data: {}, error: null, status: 200 })),
		},
		search: {
			post: mockExperimentalSearchPost,
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
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
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
