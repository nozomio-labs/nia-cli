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
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-02T00:00:00Z",
				},
			],
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

const mockCreateExperimentalClient = mock(() => ({
	usage: {
		get: mockExperimentalUsageGet,
	},
	sources: Object.assign(
		(params: { sourceId: string | number }) => ({
			get: mock(() =>
				Promise.resolve({
					data: { id: String(params.sourceId) },
					error: null,
					status: 200,
				}),
			),
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
		search = {};
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
		mockCreateExperimentalClient.mockClear();
		mockExperimentalUsageGet.mockClear();
		mockExperimentalSourcesPost.mockClear();
		mockExperimentalSourcesGet.mockClear();
		mockExperimentalSourcesResolveGet.mockClear();
		mockLegacyUsageGet.mockClear();
		mockLegacySourcesCreate.mockClear();
		mockLegacySourcesList.mockClear();
		mockLegacySourcesResolve.mockClear();
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
		expect(result).toEqual({
			userId: "user_exp",
			tier: "Pro",
			period: "2026-01-01 - 2026-02-01",
			usage: {
				queries: { used: 1, remaining: 9, limit: 10 },
			},
		});
	});

	test("uses the experimental sdk for supported source endpoints and normalizes fields", async () => {
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
		expect(mockExperimentalSourcesGet).toHaveBeenCalledTimes(1);
		expect(mockExperimentalSourcesResolveGet).toHaveBeenCalledWith({
			query: {
				identifier: "Example Docs",
				type: "documentation",
			},
		});

		expect(created).toMatchObject({
			action: "indexing_requested",
			id: "src_exp_123",
			display_name: "Example Docs",
		});
		expect(listed).toMatchObject({
			items: [
				{
					id: "src_exp_123",
					display_name: "Example Docs",
				},
			],
			pagination: {
				has_more: false,
			},
		});
		expect(resolved).toMatchObject({
			query: "Example Docs",
			items: [
				{
					id: "src_exp_123",
					display_name: "Example Docs",
				},
			],
		});
		expect(mockLegacySourcesCreate).not.toHaveBeenCalled();
		expect(mockLegacySourcesList).not.toHaveBeenCalled();
		expect(mockLegacySourcesResolve).not.toHaveBeenCalled();
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

		expect(sdk.experimental).toBe(false);
		expect(mockCreateExperimentalClient).not.toHaveBeenCalled();
		expect(mockLegacyUsageGet).toHaveBeenCalledTimes(1);
		expect(mockLegacySourcesList).toHaveBeenCalledWith({ query: "legacy" });
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
		(
			mockExperimentalUsageGet as ReturnType<typeof mock>
		).mockImplementationOnce(() =>
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
			body: { message: "Unauthorized" },
		});
	});

	test("falls back to legacy usage when experimental sdk returns 500", async () => {
		(
			mockExperimentalUsageGet as ReturnType<typeof mock>
		).mockImplementationOnce(() =>
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
		const result = await sdk.usage.getSummary();

		expect(mockExperimentalUsageGet).toHaveBeenCalledTimes(1);
		expect(mockLegacyUsageGet).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ tier: "Free", usage: {} });
	});

	test("falls back to legacy sources resolve when experimental sdk returns 500", async () => {
		(
			mockExperimentalSourcesResolveGet as ReturnType<typeof mock>
		).mockImplementationOnce(() =>
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
});
