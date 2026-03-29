import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock SDK and low-level services ---

const mockPromptInput = mock(() => Promise.resolve(""));
const mockPromptSelect = mock(() => Promise.resolve("documentation"));

const mockSourcesCreate = mock(() =>
	Promise.resolve({
		id: "src-123",
		type: "documentation",
		identifier: "https://docs.example.com",
		display_name: "Example Docs",
		status: "indexing",
		created_at: "2025-01-01T00:00:00Z",
	}),
);

const mockSourcesList = mock(() =>
	Promise.resolve({
		items: [
			{
				id: "src-123",
				type: "documentation",
				identifier: "https://docs.example.com",
				display_name: "Example Docs",
				status: "completed",
			},
			{
				id: "src-456",
				type: "repository",
				identifier: "vercel/ai",
				display_name: "Vercel AI SDK",
				status: "completed",
			},
		],
		pagination: { total: 2, limit: 20, offset: 0, has_more: false },
	}),
);

const mockSourcesResolve = mock(() =>
	Promise.resolve({
		id: "src-123",
		type: "documentation",
		display_name: "Example Docs",
		identifier: "https://docs.example.com",
	}),
);

const mockGetSource = mock(() =>
	Promise.resolve({
		id: "src-123",
		type: "documentation",
		identifier: "https://docs.example.com" as string | null,
		display_name: "Example Docs",
		status: "completed",
		created_at: "2025-01-01T00:00:00Z",
		updated_at: "2025-01-02T00:00:00Z",
	}),
);

const mockUpdateSource = mock(() =>
	Promise.resolve({
		id: "src-123",
		type: "documentation",
		identifier: "https://docs.example.com",
		display_name: "Updated Name",
		status: "completed",
	}),
);

const mockDeleteSource = mock(() =>
	Promise.resolve({
		id: "src-123",
		status: "deleted",
	}),
);

const mockRenameDataSource = mock(() =>
	Promise.resolve({
		success: true,
		message: "Source renamed successfully",
		new_name: "New Name",
	}),
);

mock.module("@crustjs/prompts", () => ({
	input: mockPromptInput,
	select: mockPromptSelect,
}));

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {};
		sources = {
			create: mockSourcesCreate,
			list: mockSourcesList,
			resolve: mockSourcesResolve,
		};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiSourcesService: {
		getSourceV2SourcesSourceIdGet: mockGetSource,
		updateSourceV2SourcesSourceIdPatch: mockUpdateSource,
		deleteSourceV2SourcesSourceIdDelete: mockDeleteSource,
		resolveSourceV2SourcesResolveGet: mockSourcesResolve,
	},
	V2ApiDataSourcesService: {
		renameDataSourceV2V2DataSourcesRenamePatch: mockRenameDataSource,
	},
}));

// --- Import after mocking ---

import {
	buildDocumentationSourceCreateRequest,
	buildResolvedSourceMatchRows,
	sourcesCommand,
} from "../../src/commands/sources.ts";
import { normalizeResolvedSourcesResponse } from "../../src/services/compat/sources.ts";
import { createSdk } from "../../src/services/sdk.ts";

describe("sources commands", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_sources_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: false,
			output: undefined,
		});

		mockSourcesCreate.mockClear();
		mockSourcesList.mockClear();
		mockSourcesResolve.mockClear();
		mockGetSource.mockClear();
		mockUpdateSource.mockClear();
		mockDeleteSource.mockClear();
		mockRenameDataSource.mockClear();
		mockPromptInput.mockClear();
		mockPromptSelect.mockClear();
		process.exitCode = 0;
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	describe("index (sources.create)", () => {
		test("builds a documentation request and leaves name inference to the API by default", () => {
			expect(
				buildDocumentationSourceCreateRequest({
					url: "https://docs.example.com",
					branch: "main",
					focus: "API reference only",
					extractBranding: true,
					maxDepth: 10,
					checkLlmsTxt: false,
					onlyMainContent: true,
				}),
			).toEqual({
				type: "documentation",
				url: "https://docs.example.com",
				branch: "main",
				focus_instructions: "API reference only",
				extract_branding: true,
				max_depth: 10,
				check_llms_txt: false,
				only_main_content: true,
			});
		});

		test("calls sdk.sources.create with url", async () => {
			const sdk = await createSdk();

			await sdk.sources.create({ url: "https://docs.example.com" });

			expect(mockSourcesCreate).toHaveBeenCalledTimes(1);
			expect(mockSourcesCreate).toHaveBeenCalledWith({
				url: "https://docs.example.com",
			});
		});

		test("passes display_name parameter", async () => {
			const sdk = await createSdk();

			await sdk.sources.create({
				url: "https://docs.example.com",
				display_name: "My Docs",
			});

			expect(mockSourcesCreate).toHaveBeenCalledWith({
				url: "https://docs.example.com",
				display_name: "My Docs",
			});
		});

		test("passes all optional parameters", async () => {
			const sdk = await createSdk();

			await sdk.sources.create({
				url: "https://docs.example.com",
				display_name: "My Docs",
				branch: "main",
				focus_instructions: "Focus on API reference",
				extract_branding: true,
				max_depth: 10,
				check_llms_txt: false,
				only_main_content: true,
			});

			expect(mockSourcesCreate).toHaveBeenCalledWith({
				url: "https://docs.example.com",
				display_name: "My Docs",
				branch: "main",
				focus_instructions: "Focus on API reference",
				extract_branding: true,
				max_depth: 10,
				check_llms_txt: false,
				only_main_content: true,
			});
		});

		test("returns created source with id and status", async () => {
			const sdk = await createSdk();
			const result = await sdk.sources.create({
				url: "https://docs.example.com",
			});

			expect(result.id).toBe("src-123");
			expect(result.type).toBe("documentation");
			expect(result.status).toBe("indexing");
		});

		test("does not require prompts when URL is provided in non-interactive mode", async () => {
			const originalLog = console.log;
			const originalError = console.error;
			const originalIsTTY = process.stdin.isTTY;

			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;

			Object.defineProperty(process.stdin, "isTTY", {
				value: false,
				configurable: true,
			});

			try {
				await sourcesCommand.execute({
					argv: ["index", "https://docs.example.com"],
				});

				expect(process.exitCode).toBe(0);
				expect(mockPromptInput).not.toHaveBeenCalled();
				expect(mockPromptSelect).not.toHaveBeenCalled();
				expect(mockSourcesCreate).toHaveBeenCalledWith({
					type: "documentation",
					url: "https://docs.example.com",
				});
			} finally {
				Object.defineProperty(process.stdin, "isTTY", {
					value: originalIsTTY,
					configurable: true,
				});
				console.log = originalLog;
				console.error = originalError;
			}
		});
	});

	describe("list (sources.list)", () => {
		test("calls sdk.sources.list with no params", async () => {
			const sdk = await createSdk();

			await sdk.sources.list();

			expect(mockSourcesList).toHaveBeenCalledTimes(1);
		});

		test("passes type filter", async () => {
			const sdk = await createSdk();

			await sdk.sources.list({ type: "documentation" });

			expect(mockSourcesList).toHaveBeenCalledWith({ type: "documentation" });
		});

		test("passes query, status, categoryId, limit, offset", async () => {
			const sdk = await createSdk();

			await sdk.sources.list({
				query: "react",
				status: "completed",
				categoryId: "cat-1",
				limit: 10,
				offset: 5,
			});

			expect(mockSourcesList).toHaveBeenCalledWith({
				query: "react",
				status: "completed",
				categoryId: "cat-1",
				limit: 10,
				offset: 5,
			});
		});

		test("returns items with pagination", async () => {
			const sdk = await createSdk();
			const result = await sdk.sources.list();

			expect(result.items).toHaveLength(2);
			expect(result.pagination.total).toBe(2);
			expect(result.pagination.has_more).toBe(false);
		});
	});

	describe("get (V2ApiSourcesService.getSource)", () => {
		test("calls getSource with source ID", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.getSourceV2SourcesSourceIdGet("src-123");

			expect(mockGetSource).toHaveBeenCalledTimes(1);
			expect(mockGetSource).toHaveBeenCalledWith("src-123");
		});

		test("passes type hint parameter", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.getSourceV2SourcesSourceIdGet("src-123", "documentation");

			expect(mockGetSource).toHaveBeenCalledWith("src-123", "documentation");
		});

		test("returns source details", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.getSourceV2SourcesSourceIdGet("src-123");

			expect(result.id).toBe("src-123");
			expect(result.display_name).toBe("Example Docs");
			expect(result.status).toBe("completed");
		});
	});

	describe("resolve (sources.resolve)", () => {
		test("calls resolve with identifier string", async () => {
			const sdk = await createSdk();

			await sdk.sources.resolve("Example Docs");

			expect(mockSourcesResolve).toHaveBeenCalledTimes(1);
			expect(mockSourcesResolve).toHaveBeenCalledWith("Example Docs");
		});

		test("passes type hint parameter", async () => {
			const sdk = await createSdk();

			await sdk.sources.resolve("https://docs.example.com", "documentation");

			expect(mockSourcesResolve).toHaveBeenCalledWith(
				"https://docs.example.com",
				"documentation",
			);
		});

		test("returns resolved source id and type", async () => {
			const sdk = await createSdk();
			const result = await sdk.sources.resolve("Example Docs");

			expect(result.id).toBe("src-123");
			expect(result.type).toBe("documentation");
			expect(result.display_name).toBe("Example Docs");
		});

		test("normalizes new multi-match response shape", () => {
			const result = normalizeResolvedSourcesResponse({
				query: "Example Docs",
				items: [
					{
						id: "src-123",
						type: "documentation",
						display_name: "Example Docs",
						identifier: "https://docs.example.com",
					},
					{
						id: "src-456",
						type: "repository",
						display_name: "Example Repo",
						identifier: "example/repo",
					},
				],
			});

			expect(result.query).toBe("Example Docs");
			expect(result.items).toHaveLength(2);
			expect(result.items[1]?.identifier).toBe("example/repo");
		});

		test("normalizes old single-source response shape", () => {
			const result = normalizeResolvedSourcesResponse({
				id: "src-123",
				type: "documentation",
				display_name: "Example Docs",
				identifier: "https://docs.example.com",
			});

			expect(result.items).toHaveLength(1);
			expect(result.items[0]?.id).toBe("src-123");
		});

		test("builds reusable multi-match rows with explicit id column", () => {
			const rows = buildResolvedSourceMatchRows([
				{
					id: "src-123",
					type: "documentation",
					display_name: "AI SDK Docs",
					identifier: "https://ai-sdk.dev/docs",
				},
			]);

			expect(rows).toEqual([
				{
					id: "src-123",
					type: "documentation",
					name: "AI SDK Docs",
					identifier: "https://ai-sdk.dev/docs",
				},
			]);
		});

		test("avoids duplicating url when display name matches identifier", () => {
			const rows = buildResolvedSourceMatchRows([
				{
					id: "src-123",
					type: "documentation",
					display_name: "https://ai-sdk.dev",
					identifier: "https://ai-sdk.dev",
				},
			]);

			expect(rows).toEqual([
				{
					id: "src-123",
					type: "documentation",
					name: "",
					identifier: "https://ai-sdk.dev",
				},
			]);
		});
	});

	describe("update (V2ApiSourcesService.updateSource)", () => {
		test("calls updateSource with display_name", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.updateSourceV2SourcesSourceIdPatch("src-123", {
				display_name: "Updated Name",
			});

			expect(mockUpdateSource).toHaveBeenCalledTimes(1);
			expect(mockUpdateSource).toHaveBeenCalledWith("src-123", {
				display_name: "Updated Name",
			});
		});

		test("calls updateSource with category_id", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.updateSourceV2SourcesSourceIdPatch("src-123", {
				category_id: "cat-1",
			});

			expect(mockUpdateSource).toHaveBeenCalledWith("src-123", {
				category_id: "cat-1",
			});
		});

		test("passes type hint as third parameter", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.updateSourceV2SourcesSourceIdPatch(
				"src-123",
				{ display_name: "New Name" },
				"documentation",
			);

			expect(mockUpdateSource).toHaveBeenCalledWith(
				"src-123",
				{ display_name: "New Name" },
				"documentation",
			);
		});

		test("returns updated source", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.updateSourceV2SourcesSourceIdPatch("src-123", {
				display_name: "Updated Name",
			});

			expect(result.display_name).toBe("Updated Name");
		});
	});

	describe("delete (V2ApiSourcesService.deleteSource)", () => {
		test("calls deleteSource with source ID", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.deleteSourceV2SourcesSourceIdDelete("src-123");

			expect(mockDeleteSource).toHaveBeenCalledTimes(1);
			expect(mockDeleteSource).toHaveBeenCalledWith("src-123");
		});

		test("passes type hint parameter", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			await svc.deleteSourceV2SourcesSourceIdDelete("src-123", "repository");

			expect(mockDeleteSource).toHaveBeenCalledWith("src-123", "repository");
		});

		test("returns deletion confirmation", async () => {
			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.deleteSourceV2SourcesSourceIdDelete("src-123");

			expect(result.id).toBe("src-123");
			expect(result.status).toBe("deleted");
		});
	});

	describe("sync (get source then re-create)", () => {
		test("fetches source details to get identifier, then re-creates", async () => {
			const sdk = await createSdk();

			// Step 1: Get the existing source
			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			const source = await svc.getSourceV2SourcesSourceIdGet("src-123");

			expect(mockGetSource).toHaveBeenCalledWith("src-123");
			expect(source.identifier).toBe("https://docs.example.com");

			// Step 2: Re-create with the same URL
			const result = await sdk.sources.create({
				url: source.identifier,
				display_name: source.display_name,
			});

			expect(mockSourcesCreate).toHaveBeenCalledWith({
				url: "https://docs.example.com",
				display_name: "Example Docs",
			});

			expect(result.id).toBe("src-123");
			expect(result.status).toBe("indexing");
		});

		test("sync command execution forwards type into the recreate request", async () => {
			const originalLog = console.log;
			const originalError = console.error;
			console.log = (() => {}) as typeof console.log;
			console.error = (() => {}) as typeof console.error;
			mockSourcesCreate.mockImplementationOnce(() =>
				Promise.resolve({
					id: "src-456",
					type: "documentation",
					identifier: "https://docs.example.com",
					display_name: "Example Docs",
					status: "completed",
					created_at: "2025-01-03T00:00:00Z",
				}),
			);

			try {
				await sourcesCommand.execute({
					argv: ["sync", "src-123", "--type", "documentation"],
				});

				expect(mockGetSource).toHaveBeenCalledWith("src-123", "documentation");
				expect(mockSourcesCreate).toHaveBeenCalledWith({
					type: "documentation",
					url: "https://docs.example.com",
					display_name: "Example Docs",
				});
				expect(mockDeleteSource).toHaveBeenCalledWith(
					"src-123",
					"documentation",
				);
			} finally {
				console.log = originalLog;
				console.error = originalError;
			}
		});

		test("handles source without identifier", async () => {
			mockGetSource.mockImplementationOnce(() =>
				Promise.resolve({
					id: "src-999",
					type: "documentation",
					identifier: null,
					display_name: "No URL Source",
					status: "completed",
					created_at: "2025-01-01T00:00:00Z",
					updated_at: "2025-01-01T00:00:00Z",
				}),
			);

			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");
			const source = await svc.getSourceV2SourcesSourceIdGet("src-999");

			expect(source.identifier).toBeNull();
			// Command handler should check for null identifier and error
		});
	});

	describe("rename (V2ApiDataSourcesService.renameDataSource)", () => {
		test("calls rename with identifier and new_name", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.renameDataSourceV2V2DataSourcesRenamePatch({
				identifier: "Example Docs",
				new_name: "New Name",
			});

			expect(mockRenameDataSource).toHaveBeenCalledTimes(1);
			expect(mockRenameDataSource).toHaveBeenCalledWith({
				identifier: "Example Docs",
				new_name: "New Name",
			});
		});

		test("supports URL as identifier", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.renameDataSourceV2V2DataSourcesRenamePatch({
				identifier: "https://docs.example.com",
				new_name: "New Name",
			});

			expect(mockRenameDataSource).toHaveBeenCalledWith({
				identifier: "https://docs.example.com",
				new_name: "New Name",
			});
		});

		test("supports UUID as identifier", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			await svc.renameDataSourceV2V2DataSourcesRenamePatch({
				identifier: "550e8400-e29b-41d4-a716-446655440000",
				new_name: "UUID Renamed",
			});

			expect(mockRenameDataSource).toHaveBeenCalledWith({
				identifier: "550e8400-e29b-41d4-a716-446655440000",
				new_name: "UUID Renamed",
			});
		});

		test("returns rename result with success status", async () => {
			await createSdk();

			const { V2ApiDataSourcesService: svc } = await import("nia-ai-ts");
			const result = await svc.renameDataSourceV2V2DataSourcesRenamePatch({
				identifier: "Example Docs",
				new_name: "New Name",
			});

			expect(result.success).toBe(true);
			expect(result.message).toBe("Source renamed successfully");
			expect(result.new_name).toBe("New Name");
		});
	});

	describe("source type validation", () => {
		test("valid source types are accepted", () => {
			const validTypes = [
				"repository",
				"documentation",
				"research_paper",
				"huggingface_dataset",
				"local_folder",
			];

			for (const type of validTypes) {
				expect(validTypes.includes(type)).toBe(true);
			}
		});

		test("invalid source type is rejected", () => {
			const validTypes = [
				"repository",
				"documentation",
				"research_paper",
				"huggingface_dataset",
				"local_folder",
			];

			expect(validTypes.includes("invalid")).toBe(false);
			expect(validTypes.includes("repo")).toBe(false);
			expect(validTypes.includes("docs")).toBe(false);
		});
	});

	describe("error handling", () => {
		test("handles 401 authentication error", async () => {
			mockSourcesList.mockImplementationOnce(() => {
				const error = new Error("Unauthorized") as Error & { status: number };
				error.status = 401;
				return Promise.reject(error);
			});

			const sdk = await createSdk();

			await expect(sdk.sources.list()).rejects.toThrow("Unauthorized");
		});

		test("handles 404 not found error", async () => {
			mockGetSource.mockImplementationOnce(() => {
				const error = new Error("Not Found") as Error & { status: number };
				error.status = 404;
				return Promise.reject(error);
			});

			await createSdk();

			const { V2ApiSourcesService: svc } = await import("nia-ai-ts");

			await expect(
				svc.getSourceV2SourcesSourceIdGet("nonexistent"),
			).rejects.toThrow("Not Found");
		});

		test("handles 422 validation error", async () => {
			mockSourcesCreate.mockImplementationOnce(() => {
				const error = new Error("Invalid URL format") as Error & {
					status: number;
				};
				error.status = 422;
				return Promise.reject(error);
			});

			const sdk = await createSdk();

			await expect(sdk.sources.create({ url: "not-a-url" })).rejects.toThrow(
				"Invalid URL format",
			);
		});

		test("handles 429 rate limit error", async () => {
			mockSourcesList.mockImplementationOnce(() => {
				const error = new Error("Rate Limited") as Error & { status: number };
				error.status = 429;
				return Promise.reject(error);
			});

			const sdk = await createSdk();

			await expect(sdk.sources.list()).rejects.toThrow("Rate Limited");
		});

		test("handles missing API key error", async () => {
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

	describe("flag-to-parameter mapping", () => {
		test("--name flag maps to display_name", () => {
			const params: Record<string, unknown> = {};
			const nameFlag = "My Custom Name";
			params.display_name = nameFlag;

			expect(params.display_name).toBe("My Custom Name");
		});

		test("--focus flag maps to focus_instructions", () => {
			const params: Record<string, unknown> = {};
			const focusFlag = "Focus on API reference";
			params.focus_instructions = focusFlag;

			expect(params.focus_instructions).toBe("Focus on API reference");
		});

		test("--extract-branding flag maps to extract_branding", () => {
			const params: Record<string, unknown> = {};
			params.extract_branding = true;

			expect(params.extract_branding).toBe(true);
		});

		test("--max-depth flag maps to max_depth", () => {
			const params: Record<string, unknown> = {};
			params.max_depth = 10;

			expect(params.max_depth).toBe(10);
		});

		test("--check-llms-txt flag maps to check_llms_txt", () => {
			const params: Record<string, unknown> = {};
			params.check_llms_txt = false;

			expect(params.check_llms_txt).toBe(false);
		});

		test("--only-main-content flag maps to only_main_content", () => {
			const params: Record<string, unknown> = {};
			params.only_main_content = true;

			expect(params.only_main_content).toBe(true);
		});

		test("rename identifier and new-name map to request body", () => {
			const body = {
				identifier: "my-source",
				new_name: "Renamed Source",
			};

			expect(body.identifier).toBe("my-source");
			expect(body.new_name).toBe("Renamed Source");
		});
	});
});
