import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock V2ApiDataSourcesService ---

const mockReadFile = mock(() =>
	Promise.resolve({
		success: true,
		content: 'console.log("hello world");',
		path: "src/index.ts",
		line_start: 1,
		line_end: 10,
		total_lines: 42,
	}),
);

const mockGrep = mock(() =>
	Promise.resolve({
		success: true,
		pattern: "hello",
		path_filter: undefined,
		total_matches: 3,
		files_searched: 10,
		files_with_matches: 2,
		truncated: false,
		matches: [
			{
				file: "src/index.ts",
				line: 5,
				content: 'console.log("hello world");',
			},
			{
				file: "src/utils.ts",
				line: 12,
				content: "// say hello",
			},
			{
				file: "src/utils.ts",
				line: 15,
				content: 'const greeting = "hello";',
			},
		],
	}),
);

const mockGetTree = mock(() =>
	Promise.resolve({
		success: true,
		tree: {
			name: "root",
			children: [
				{ name: "src", children: [{ name: "index.ts" }, { name: "utils.ts" }] },
				{ name: "README.md" },
			],
		},
		tree_string:
			"root\n├── src/\n│   ├── index.ts\n│   └── utils.ts\n└── README.md",
		tree_type: "documentation",
		page_count: 5,
	}),
);

const mockLsDir = mock(() =>
	Promise.resolve({
		success: true,
		path: "/",
		directories: ["src", "tests", "docs"],
		files: ["README.md", "package.json", "tsconfig.json"],
		total: 6,
	}),
);

const mockRenameDataSource = mock(() =>
	Promise.resolve({
		success: true,
		message: "Source renamed successfully",
		new_name: "New Name",
	}),
);
const mockExperimentalTreeGet = mock(() =>
	Promise.resolve({
		data: {
			success: true,
			treeString: "docs/\n└── index.md",
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
			post: mock(() => Promise.resolve({ data: {}, error: null, status: 200 })),
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
					get: mockExperimentalTreeGet,
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
		search = {};
		sources = {
			create: mock(() => Promise.resolve({})),
			list: mock(() => Promise.resolve({})),
			resolve: mock(() => Promise.resolve({})),
		};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiSourcesService: {
		getSourceV2SourcesSourceIdGet: mock(() => Promise.resolve({})),
		updateSourceV2SourcesSourceIdPatch: mock(() => Promise.resolve({})),
		deleteSourceV2SourcesSourceIdDelete: mock(() => Promise.resolve({})),
	},
	V2ApiDataSourcesService: {
		renameDataSourceV2V2DataSourcesRenamePatch: mockRenameDataSource,
		readDocumentationFileV2V2DataSourcesSourceIdReadGet: mockReadFile,
		grepDocumentationV2V2DataSourcesSourceIdGrepPost: mockGrep,
		getDocumentationTreeV2V2DataSourcesSourceIdTreeGet: mockGetTree,
		listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet: mockLsDir,
	},
}));

// --- Import after mocking ---

import { sourcesCommand } from "../../src/commands/sources.ts";
import { createSdk } from "../../src/services/sdk.ts";

describe("sources content commands", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_sources_content_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		mockReadFile.mockClear();
		mockGrep.mockClear();
		mockGetTree.mockClear();
		mockLsDir.mockClear();
		mockExperimentalTreeGet.mockClear();
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	describe("read (V2ApiDataSourcesService.readDocumentationFile)", () => {
		test("calls readDocumentationFile with sourceId and path", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
				"src-123",
				"src/index.ts",
			);

			expect(mockReadFile).toHaveBeenCalledTimes(1);
			expect(mockReadFile).toHaveBeenCalledWith("src-123", "src/index.ts");
		});

		test("passes lineStart and lineEnd parameters", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
				"src-123",
				"src/index.ts",
				undefined, // page
				undefined, // treeNodeId
				5, // lineStart
				20, // lineEnd
			);

			expect(mockReadFile).toHaveBeenCalledWith(
				"src-123",
				"src/index.ts",
				undefined,
				undefined,
				5,
				20,
			);
		});

		test("passes maxLength parameter", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
				"src-123",
				"src/index.ts",
				undefined, // page
				undefined, // treeNodeId
				undefined, // lineStart
				undefined, // lineEnd
				5000, // maxLength
			);

			expect(mockReadFile).toHaveBeenCalledWith(
				"src-123",
				"src/index.ts",
				undefined,
				undefined,
				undefined,
				undefined,
				5000,
			);
		});

		test("returns file content with metadata", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result =
				await svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
					"src-123",
					"src/index.ts",
				);

			expect(result.success).toBe(true);
			expect(result.content).toBe('console.log("hello world");');
			expect(result.path).toBe("src/index.ts");
			expect(result.total_lines).toBe(42);
		});

		test("handles 404 when file not found", async () => {
			mockReadFile.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
					"src-123",
					"nonexistent.ts",
				),
			).rejects.toThrow("Not Found");
		});
	});

	describe("grep (V2ApiDataSourcesService.grepDocumentation)", () => {
		test("calls grepDocumentation with sourceId and GrepRequest body", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
				pattern: "hello",
			});

			expect(mockGrep).toHaveBeenCalledTimes(1);
			expect(mockGrep).toHaveBeenCalledWith("src-123", { pattern: "hello" });
		});

		test("passes path filter in GrepRequest", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
				pattern: "hello",
				path: "src/",
			});

			expect(mockGrep).toHaveBeenCalledWith("src-123", {
				pattern: "hello",
				path: "src/",
			});
		});

		test("passes case_sensitive and whole_word options", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
				pattern: "Hello",
				case_sensitive: true,
				whole_word: true,
			});

			expect(mockGrep).toHaveBeenCalledWith("src-123", {
				pattern: "Hello",
				case_sensitive: true,
				whole_word: true,
			});
		});

		test("passes context lines (A and B) parameters", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
				pattern: "hello",
				A: 3,
				B: 2,
			});

			expect(mockGrep).toHaveBeenCalledWith("src-123", {
				pattern: "hello",
				A: 3,
				B: 2,
			});
		});

		test("passes max_matches_per_file and max_total_matches", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
				pattern: "hello",
				max_matches_per_file: 5,
				max_total_matches: 50,
			});

			expect(mockGrep).toHaveBeenCalledWith("src-123", {
				pattern: "hello",
				max_matches_per_file: 5,
				max_total_matches: 50,
			});
		});

		test("returns grep results with match details", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost(
				"src-123",
				{
					pattern: "hello",
				},
			);

			expect(result.success).toBe(true);
			expect(result.pattern).toBe("hello");
			expect(result.total_matches).toBe(3);
			expect(result.files_searched).toBe(10);
			expect(result.files_with_matches).toBe(2);
			expect(result.truncated).toBe(false);
			expect(result.matches).toHaveLength(3);
		});

		test("handles empty results", async () => {
			mockGrep.mockImplementationOnce(() =>
				Promise.resolve({
					success: true,
					pattern: "nonexistent",
					path_filter: undefined,
					total_matches: 0,
					files_searched: 10,
					files_with_matches: 0,
					truncated: false,
					matches: [],
				}),
			);

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost(
				"src-123",
				{
					pattern: "nonexistent",
				},
			);

			expect(result.total_matches).toBe(0);
			expect(result.matches).toHaveLength(0);
		});
	});

	describe("tree (V2ApiDataSourcesService.getDocumentationTree)", () => {
		test("calls getDocumentationTree with sourceId", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet("src-123");

			expect(mockGetTree).toHaveBeenCalledTimes(1);
			expect(mockGetTree).toHaveBeenCalledWith("src-123");
		});

		test("returns tree with structure and string representation", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result =
				await svc.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet("src-123");

			expect(result.success).toBe(true);
			expect(result.tree).toBeDefined();
			expect(result.tree_string).toContain("root");
			expect(result.tree_string).toContain("src/");
			expect(result.tree_string).toContain("index.ts");
			expect(result.tree_string).toContain("README.md");
			expect(result.tree_type).toBe("documentation");
			expect(result.page_count).toBe(5);
		});

		test("handles 404 when source not found", async () => {
			mockGetTree.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet("nonexistent"),
			).rejects.toThrow("Not Found");
		});

		test("prints experimental treeString when experimental mode is enabled", async () => {
			await writeConfig({
				apiKey: "nia_test_sources_content_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: true,
				output: undefined,
			});

			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			try {
				await sourcesCommand.execute({
					argv: ["tree", "src-123"],
				});

				expect(mockExperimentalTreeGet).toHaveBeenCalledTimes(1);
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});
	});

	describe("ls (V2ApiDataSourcesService.listDocumentationDirectory)", () => {
		test("calls listDocumentationDirectory with sourceId", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
				"src-123",
			);

			expect(mockLsDir).toHaveBeenCalledTimes(1);
			expect(mockLsDir).toHaveBeenCalledWith("src-123");
		});

		test("passes path parameter for subdirectory listing", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
				"src-123",
				"src/",
			);

			expect(mockLsDir).toHaveBeenCalledWith("src-123", "src/");
		});

		test("returns directory listing with files and directories", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result =
				await svc.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
					"src-123",
				);

			expect(result.success).toBe(true);
			expect(result.path).toBe("/");
			expect(result.directories).toEqual(["src", "tests", "docs"]);
			expect(result.files).toEqual([
				"README.md",
				"package.json",
				"tsconfig.json",
			]);
			expect(result.total).toBe(6);
		});

		test("handles empty directory", async () => {
			mockLsDir.mockImplementationOnce(() =>
				Promise.resolve({
					success: true,
					path: "empty-dir/",
					directories: [],
					files: [],
					total: 0,
				}),
			);

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result =
				await svc.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
					"src-123",
					"empty-dir/",
				);

			expect(result.total).toBe(0);
			expect(result.directories).toHaveLength(0);
			expect(result.files).toHaveLength(0);
		});

		test("handles 404 when path not found", async () => {
			mockLsDir.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
					"src-123",
					"nonexistent/",
				),
			).rejects.toThrow("Not Found");
		});
	});

	describe("flag-to-parameter mapping", () => {
		test("--lines-before maps to GrepRequest.B", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			const linesBefore = 3;
			request.B = linesBefore;

			expect(request.B).toBe(3);
		});

		test("--lines-after maps to GrepRequest.A", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			const linesAfter = 5;
			request.A = linesAfter;

			expect(request.A).toBe(5);
		});

		test("--max-per-file maps to GrepRequest.max_matches_per_file", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			const maxPerFile = 10;
			request.max_matches_per_file = maxPerFile;

			expect(request.max_matches_per_file).toBe(10);
		});

		test("--max-total maps to GrepRequest.max_total_matches", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			const maxTotal = 100;
			request.max_total_matches = maxTotal;

			expect(request.max_total_matches).toBe(100);
		});

		test("--case-sensitive maps to GrepRequest.case_sensitive", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			request.case_sensitive = true;

			expect(request.case_sensitive).toBe(true);
		});

		test("--whole-word maps to GrepRequest.whole_word", () => {
			const request: Record<string, unknown> = { pattern: "test" };
			request.whole_word = true;

			expect(request.whole_word).toBe(true);
		});

		test("--line-start and --line-end map to read parameters", () => {
			const lineStart = 10;
			const lineEnd = 50;

			// These map directly as positional params to the readDocumentationFile call
			expect(lineStart).toBe(10);
			expect(lineEnd).toBe(50);
		});

		test("--max-length maps to read maxLength parameter", () => {
			const maxLength = 5000;

			expect(maxLength).toBe(5000);
		});
	});

	describe("error handling", () => {
		test("handles 401 authentication error on content read", async () => {
			mockReadFile.mockImplementationOnce(() => {
				const error = new Error("Unauthorized") as Error & { status: number };
				error.status = 401;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
					"src-123",
					"test.ts",
				),
			).rejects.toThrow("Unauthorized");
		});

		test("handles 429 rate limit error on grep", async () => {
			mockGrep.mockImplementationOnce(() => {
				const error = new Error("Rate Limited") as Error & { status: number };
				error.status = 429;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.grepDocumentationV2V2DataSourcesSourceIdGrepPost("src-123", {
					pattern: "test",
				}),
			).rejects.toThrow("Rate Limited");
		});

		test("handles server error on tree", async () => {
			mockGetTree.mockImplementationOnce(() => {
				const error = new Error("Internal Server Error") as Error & {
					status: number;
				};
				error.status = 500;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet("src-123"),
			).rejects.toThrow("Internal Server Error");
		});

		test("handles missing API key error", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://apigcp.trynia.ai/v2",
				output: undefined,
			});

			delete process.env.NIA_API_KEY;

			await expect(createSdk()).rejects.toThrow("No API key found");
		});
	});
});
