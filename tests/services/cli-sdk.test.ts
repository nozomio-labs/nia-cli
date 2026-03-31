import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

const mockExperimentalUsageGet = mock(() =>
	Promise.resolve({
		data: {
			userId: "user_exp",
			tier: "Pro",
			period: "2026-01-01 - 2026-02-01",
			usage: {
				queries: { used: 1, remaining: 9, limit: 10 },
			},
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourcesPost = mock(() =>
	Promise.resolve({
		data: {
			action: "indexing_requested",
			source: {
				id: "src_exp_123",
				type: "documentation",
				identifier: "https://docs.example.com",
				displayName: "Example Docs",
				status: "indexing",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourcesGet = mock(() =>
	Promise.resolve({
		data: {
			items: [
				{
					id: "src_exp_123",
					type: "documentation",
					identifier: "https://docs.example.com",
					displayName: "Example Docs",
					status: "completed",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-02T00:00:00Z",
				},
			],
			pagination: {
				total: 1,
				limit: 20,
				offset: 0,
				hasMore: false,
			},
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourcesResolveGet = mock(() =>
	Promise.resolve({
		data: {
			query: "Example Docs",
			items: [
				{
					id: "src_exp_123",
					type: "documentation",
					identifier: "https://docs.example.com",
					displayName: "Example Docs",
					status: "completed",
				},
			],
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourceGet = mock((params: { id: string | number }) =>
	Promise.resolve({
		data: {
			id: String(params.id),
			type: "documentation",
			displayName: "Fetched Source",
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourcePatch = mock(
	(params: { id: string | number }, body: Record<string, unknown>) =>
		Promise.resolve({
			data: {
				id: String(params.id),
				displayName: body.displayName ?? "Updated Source",
			},
			error: null,
			status: 200,
		}),
);

const mockExperimentalSourceDelete = mock((params: { id: string | number }) =>
	Promise.resolve({
		data: {
			id: String(params.id),
			status: "deleted",
		},
		error: null,
		status: 200,
	}),
);

const mockExperimentalSourceTreeGet = mock(
	(params: { id: string | number }, input?: Record<string, unknown>) =>
		Promise.resolve({
			data: {
				id: String(params.id),
				treeString: "docs/\n└── index.md",
				query: input?.query,
			},
			error: null,
			status: 200,
		}),
);

const mockExperimentalSourceContentGet = mock(
	(params: { id: string | number }, input?: Record<string, unknown>) =>
		Promise.resolve({
			data: {
				id: String(params.id),
				path: "docs/index.md",
				content: "# Hello",
				query: input?.query,
			},
			error: null,
			status: 200,
		}),
);

const mockExperimentalSourceGrepPost = mock(
	(params: { id: string | number }, body: Record<string, unknown>) =>
		Promise.resolve({
			data: {
				id: String(params.id),
				pattern: body.pattern,
				matches: [],
			},
			error: null,
			status: 200,
		}),
);

const mockExperimentalSearchPost = mock((body: Record<string, unknown>) =>
	Promise.resolve({
		data: {
			mode: "query",
			execution: "snippet_search",
			query:
				Array.isArray(body.messages) &&
				body.messages[0] &&
				typeof body.messages[0] === "object" &&
				body.messages[0] !== null &&
				"content" in body.messages[0]
					? (body.messages[0].content as string)
					: "",
			content: "Found relevant indexed matches.",
			sources: [],
			followUpQuestions: [],
			readySources: [],
			blockedSources: [],
		},
		error: null,
		status: 200,
	}),
);

const mockLegacyUsageGet = mock(() =>
	Promise.resolve({ tier: "Free", usage: {} }),
);
const mockLegacySourcesCreate = mock(() =>
	Promise.resolve({ id: "legacy_src" }),
);
const mockLegacySourcesList = mock(() => Promise.resolve({ items: [] }));
const mockLegacySourcesResolve = mock(() =>
	Promise.resolve({ id: "legacy_src" }),
);
const mockLegacySearchQuery = mock(() =>
	Promise.resolve({ answer: "legacy", sources: [] }),
);
const mockLegacyGetSource = mock(() => Promise.resolve({ id: "legacy_src" }));
const mockLegacyUpdateSource = mock(() =>
	Promise.resolve({ id: "legacy_src", display_name: "Legacy Updated" }),
);
const mockLegacyDeleteSource = mock(() =>
	Promise.resolve({ id: "legacy_src", status: "deleted" }),
);
const mockLegacyReadContent = mock(() =>
	Promise.resolve({ path: "legacy.md", content: "legacy content" }),
);
const mockLegacyGrep = mock(() => Promise.resolve({ matches: [] }));
const mockLegacyTree = mock(() =>
	Promise.resolve({ tree_string: "legacy/\n└── file.ts" }),
);

const mockCreateExperimentalClient = mock(() => ({
	usage: {
		get: mockExperimentalUsageGet,
	},
	search: {
		post: mockExperimentalSearchPost,
	},
	sources: Object.assign(
		(params: { id: string | number }) => ({
			get: () => mockExperimentalSourceGet(params),
			patch: (body: Record<string, unknown>) =>
				mockExperimentalSourcePatch(params, body),
			delete: () => mockExperimentalSourceDelete(params),
			tree: {
				get: (input?: Record<string, unknown>) =>
					mockExperimentalSourceTreeGet(params, input),
			},
			content: {
				get: (input?: Record<string, unknown>) =>
					mockExperimentalSourceContentGet(params, input),
			},
			grep: {
				post: (body: Record<string, unknown>) =>
					mockExperimentalSourceGrepPost(params, body),
			},
		}),
		{
			get: mockExperimentalSourcesGet,
			post: mockExperimentalSourcesPost,
			resolve: {
				get: mockExperimentalSourcesResolveGet,
			},
		},
	),
}));

mock.module("@nozomioai/nia-sdk", () => ({
	createClient: mockCreateExperimentalClient,
}));

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {
			query: mockLegacySearchQuery,
		};
		sources = {
			create: mockLegacySourcesCreate,
			list: mockLegacySourcesList,
			resolve: mockLegacySourcesResolve,
		};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiService: {
		getUsageSummaryV2V2UsageGet: mockLegacyUsageGet,
	},
	V2ApiSourcesService: {
		getSourceV2SourcesSourceIdGet: mockLegacyGetSource,
		updateSourceV2SourcesSourceIdPatch: mockLegacyUpdateSource,
		deleteSourceV2SourcesSourceIdDelete: mockLegacyDeleteSource,
	},
	V2ApiDataSourcesService: {
		readDocumentationFileV2V2DataSourcesSourceIdReadGet: mockLegacyReadContent,
		grepDocumentationV2V2DataSourcesSourceIdGrepPost: mockLegacyGrep,
		getDocumentationTreeV2V2DataSourcesSourceIdTreeGet: mockLegacyTree,
	},
}));

import { createCliSdk } from "../../src/services/sdk.ts";
import {
	getConfigDirPath,
	resetConfig,
	setExperimentalOverride,
	writeConfig,
} from "../helpers/config-store.ts";

describe("cli sdk adapter", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		delete process.env.NIA_API_KEY;
		delete process.env.NIA_BASE_URL;
		setExperimentalOverride(undefined);

		for (const fn of [
			mockCreateExperimentalClient,
			mockExperimentalUsageGet,
			mockExperimentalSourcesPost,
			mockExperimentalSourcesGet,
			mockExperimentalSourcesResolveGet,
			mockExperimentalSourceGet,
			mockExperimentalSourcePatch,
			mockExperimentalSourceDelete,
			mockExperimentalSourceTreeGet,
			mockExperimentalSourceContentGet,
			mockExperimentalSourceGrepPost,
			mockExperimentalSearchPost,
			mockLegacyUsageGet,
			mockLegacySourcesCreate,
			mockLegacySourcesList,
			mockLegacySourcesResolve,
			mockLegacySearchQuery,
			mockLegacyGetSource,
			mockLegacyUpdateSource,
			mockLegacyDeleteSource,
			mockLegacyReadContent,
			mockLegacyGrep,
			mockLegacyTree,
		]) {
			fn.mockClear();
		}
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		delete process.env.NIA_API_KEY;
		delete process.env.NIA_BASE_URL;
		setExperimentalOverride(undefined);
	});

	test("uses the experimental sdk for usage when experimental mode is enabled", async () => {
		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();
		const result = await sdk.usage.getSummary();

		expect(sdk.experimental).toBe(true);
		expect(mockCreateExperimentalClient).toHaveBeenCalledTimes(1);
		expect(mockExperimentalUsageGet).toHaveBeenCalledTimes(1);
		expect(mockLegacyUsageGet).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			userId: "user_exp",
			tier: "Pro",
		});
	});

	test("uses the experimental sdk for source create/list/resolve and returns new shapes", async () => {
		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();
		const created = await sdk.sources.create({
			type: "documentation",
			url: "https://docs.example.com",
			display_name: "Example Docs",
		});
		const listed = await sdk.sources.list({ query: "example" });
		const resolved = await sdk.sources.resolve("Example Docs", "documentation");

		expect(mockExperimentalSourcesPost).toHaveBeenCalledWith({
			type: "documentation",
			url: "https://docs.example.com",
			displayName: "Example Docs",
		});
		expect(mockExperimentalSourcesGet).toHaveBeenCalledWith({
			query: {
				type: undefined,
				query: "example",
				status: undefined,
				limit: undefined,
				offset: undefined,
			},
		});
		expect(mockExperimentalSourcesResolveGet).toHaveBeenCalledWith({
			query: {
				identifier: "Example Docs",
				type: "documentation",
			},
		});
		expect(created).toMatchObject({
			action: "indexing_requested",
			source: {
				displayName: "Example Docs",
			},
		});
		expect(listed).toMatchObject({
			items: [
				{
					displayName: "Example Docs",
				},
			],
			pagination: {
				hasMore: false,
			},
		});
		expect(resolved).toMatchObject({
			query: "Example Docs",
			items: [
				{
					displayName: "Example Docs",
				},
			],
		});
	});

	test("uses the experimental sdk for get/update/delete/tree/content/grep and query search", async () => {
		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();
		const fetched = await sdk.sources.get("src_1");
		const updated = await sdk.sources.update("src_1", {
			displayName: "Renamed",
		});
		const deleted = await sdk.sources.delete("src_1");
		const tree = await sdk.sources.tree("src_1", { branch: "main", maxDepth: 2 });
		const content = await sdk.sources.content("src_1", {
			path: "docs/index.md",
			lineStart: 1,
			lineEnd: 10,
		});
		const grep = await sdk.sources.grep("src_1", {
			pattern: "hello",
			linesBefore: 1,
			linesAfter: 2,
		});
		const search = await sdk.search.query({
			mode: "query",
			messages: [{ role: "user", content: "How does auth work?" }],
			sources: [{ identifier: "react-docs", type: "documentation" }],
		});

		expect(mockExperimentalSourceGet).toHaveBeenCalledWith({ id: "src_1" });
		expect(mockExperimentalSourcePatch).toHaveBeenCalledWith(
			{ id: "src_1" },
			{ displayName: "Renamed" },
		);
		expect(mockExperimentalSourceDelete).toHaveBeenCalledWith({ id: "src_1" });
		expect(mockExperimentalSourceTreeGet).toHaveBeenCalledWith(
			{ id: "src_1" },
			{ query: { branch: "main", maxDepth: 2 } },
		);
		expect(mockExperimentalSourceContentGet).toHaveBeenCalledWith(
			{ id: "src_1" },
			{
				query: {
					path: "docs/index.md",
					url: undefined,
					branch: undefined,
					page: undefined,
					treeNodeId: undefined,
					lineStart: 1,
					lineEnd: 10,
					maxLength: undefined,
				},
			},
		);
		expect(mockExperimentalSourceGrepPost).toHaveBeenCalledWith(
			{ id: "src_1" },
			{
				pattern: "hello",
				linesBefore: 1,
				linesAfter: 2,
			},
		);
		expect(mockExperimentalSearchPost).toHaveBeenCalledWith({
			mode: "query",
			messages: [{ role: "user", content: "How does auth work?" }],
			sources: [{ identifier: "react-docs", type: "documentation" }],
		});
		expect(fetched).toMatchObject({ displayName: "Fetched Source" });
		expect(updated).toMatchObject({ displayName: "Renamed" });
		expect(deleted).toMatchObject({ status: "deleted" });
		expect(tree).toMatchObject({ treeString: "docs/\n└── index.md" });
		expect(content).toMatchObject({ content: "# Hello" });
		expect(grep).toMatchObject({ pattern: "hello" });
		expect(search).toMatchObject({ mode: "query", execution: "snippet_search" });
	});

	test("falls back to the legacy sdk when experimental mode is disabled", async () => {
		await writeConfig({
			apiKey: "nia_std_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: false,
			output: undefined,
		});

		const sdk = await createCliSdk();
		await sdk.usage.getSummary();
		await sdk.sources.list({ query: "legacy" });
		await sdk.search.query({ messages: [{ role: "user", content: "legacy" }] });

		expect(sdk.experimental).toBe(false);
		expect(mockCreateExperimentalClient).not.toHaveBeenCalled();
		expect(mockLegacyUsageGet).toHaveBeenCalledTimes(1);
		expect(mockLegacySourcesList).toHaveBeenCalledWith({ query: "legacy" });
		expect(mockLegacySearchQuery).toHaveBeenCalledWith({
			messages: [{ role: "user", content: "legacy" }],
		});
	});

	test("uses the experimental sdk for one invocation when runtime override is enabled", async () => {
		await writeConfig({
			apiKey: "nia_std_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: false,
			output: undefined,
		});
		setExperimentalOverride(true);

		const sdk = await createCliSdk();

		expect(sdk.experimental).toBe(true);
		expect(mockCreateExperimentalClient).toHaveBeenCalledTimes(1);
	});

	test("forces the legacy sdk for one invocation when runtime override disables experimental mode", async () => {
		process.env.NIA_BASE_URL = "https://api.trynia.ai";
		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://configured.example.com",
			useExperimentalApi: true,
			output: undefined,
		});
		setExperimentalOverride(false);

		const sdk = await createCliSdk();

		expect(sdk.experimental).toBe(false);
		expect(mockCreateExperimentalClient).not.toHaveBeenCalled();
	});

	test("rethrows experimental client errors with status for shared error handling", async () => {
		mockExperimentalUsageGet.mockImplementationOnce(() =>
			Promise.resolve({
				data: null,
				error: {
					status: 401,
					value: { message: "Unauthorized" },
				},
				status: 401,
			}),
		);

		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();

		await expect(sdk.usage.getSummary()).rejects.toMatchObject({
			message: "Unauthorized",
			status: 401,
		});
	});

	test("falls back to legacy sources resolve when experimental sdk returns 500", async () => {
		mockExperimentalSourcesResolveGet.mockImplementationOnce(() =>
			Promise.resolve({
				data: null,
				error: {
					status: 500,
					value: { message: "Internal Server Error" },
				},
				status: 500,
			}),
		);

		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();
		const result = await sdk.sources.resolve("Example Docs", "documentation");

		expect(mockExperimentalSourcesResolveGet).toHaveBeenCalledTimes(1);
		expect(mockLegacySourcesResolve).toHaveBeenCalledWith(
			"Example Docs",
			"documentation",
		);
		expect(result).toEqual({ id: "legacy_src" });
	});

	test("falls back to legacy query search when the experimental endpoint returns 500", async () => {
		mockExperimentalSearchPost.mockImplementationOnce(() =>
			Promise.resolve({
				data: null,
				error: {
					status: 500,
					value: { message: "Internal Server Error" },
				},
				status: 500,
			}),
		);

		await writeConfig({
			apiKey: "nia_exp_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			useExperimentalApi: true,
			output: undefined,
		});

		const sdk = await createCliSdk();
		const result = await sdk.search.query({
			mode: "query",
			messages: [{ role: "user", content: "How does auth work?" }],
			sources: [
				{ identifier: "vercel/ai", type: "repository" },
				{ identifier: "react-docs", type: "documentation" },
			],
		});

		expect(mockLegacySearchQuery).toHaveBeenCalledWith({
			messages: [{ role: "user", content: "How does auth work?" }],
			repositories: ["vercel/ai"],
			data_sources: ["react-docs"],
			search_mode: "unified",
		});
		expect(result).toEqual({ answer: "legacy", sources: [] });
	});
});
