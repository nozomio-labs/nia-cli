import { createClient } from "@nozomioai/nia-sdk";
import { NiaSDK, OpenAPI } from "nia-ai-ts";
import {
	configStore,
	DEFAULT_BASE_URL,
	EXPERIMENTAL_BASE_URL,
	resolveApiKey,
	resolveBaseUrl,
} from "./config.ts";

export interface CreateSdkOptions {
	/** CLI --api-key flag override */
	apiKey?: string;
	/** Explicit base URL override */
	baseUrl?: string;
}

type SourceType =
	| "repository"
	| "documentation"
	| "research_paper"
	| "huggingface_dataset"
	| "local_folder";

export interface CliSdk {
	experimental: boolean;
	usage: {
		getSummary(): Promise<unknown>;
	};
	sources: {
		create(payload: Record<string, unknown>): Promise<unknown>;
		list(params?: {
			type?: SourceType;
			query?: string;
			status?: string;
			categoryId?: string;
			limit?: number;
			offset?: number;
		}): Promise<unknown>;
		resolve(identifier: string, type?: SourceType): Promise<unknown>;
	};
}

interface ResolvedClientContext {
	apiKey: string;
	baseUrl: string;
	experimental: boolean;
}

/**
 * Create and configure a NiaSDK instance using the config resolution chain:
 *   1. Explicit override (from CLI --api-key flag)
 *   2. NIA_API_KEY environment variable
 *   3. Config file (~/.config/nia/config.json)
 *
 * Also configures the OpenAPI singleton for low-level service classes.
 *
 * Throws if no API key is found anywhere in the chain.
 */
export async function createSdk(
	options: CreateSdkOptions = {},
): Promise<NiaSDK> {
	const { apiKey, baseUrl } = await resolveClientContext(options);

	// Configure the OpenAPI singleton for low-level service classes
	// (V2ApiRepositoriesService, V2ApiDataSourcesService, etc.)
	OpenAPI.BASE = baseUrl;
	OpenAPI.TOKEN = apiKey;

	return new NiaSDK({
		apiKey,
		baseUrl,
	});
}

export async function createCliSdk(
	options: CreateSdkOptions = {},
): Promise<CliSdk> {
	const context = await resolveClientContext(options);

	configureOpenApi(context.apiKey, context.baseUrl);

	if (!context.experimental) {
		const sdk = new NiaSDK({
			apiKey: context.apiKey,
			baseUrl: context.baseUrl,
		});

		return {
			experimental: false,
			usage: {
				async getSummary() {
					const { V2ApiService } = await import("nia-ai-ts");
					return V2ApiService.getUsageSummaryV2V2UsageGet();
				},
			},
			sources: {
				create(payload) {
					return sdk.sources.create(payload);
				},
				list(params) {
					return sdk.sources.list(params);
				},
				resolve(identifier, type) {
					return sdk.sources.resolve(identifier, type);
				},
			},
		};
	}

	const client = createClient(context.baseUrl, {
		apiKey: context.apiKey,
	});
	const legacySdk = new NiaSDK({
		apiKey: context.apiKey,
		baseUrl: context.baseUrl,
	});
	const getLegacyUsageSummary = async (): Promise<unknown> => {
		const { V2ApiService } = await import("nia-ai-ts");
		return V2ApiService.getUsageSummaryV2V2UsageGet();
	};

	return {
		experimental: true,
		usage: {
			async getSummary() {
				return withExperimentalFallback<unknown>(
					async () => unwrapExperimentalResponse(await client.usage.get()),
					getLegacyUsageSummary,
				);
			},
		},
		sources: {
			async create(payload) {
				if (requiresLegacyExperimentalSourceCreate(payload)) {
					return legacySdk.sources.create(payload);
				}

				return withExperimentalFallback(
					async () =>
						normalizeExperimentalCreateSourceResponse(
							unwrapExperimentalResponse(
								await client.sources.post(
									toExperimentalCreateSourceBody(payload),
								),
							),
						),
					() => legacySdk.sources.create(payload),
				);
			},
			async list(params) {
				if (params?.categoryId) {
					return legacySdk.sources.list(params);
				}

				return withExperimentalFallback(
					async () =>
						normalizeExperimentalListSourcesResponse(
							unwrapExperimentalResponse(
								await client.sources.get({
									query: {
										type: params?.type,
										query: params?.query,
										status: params?.status,
										limit: params?.limit,
										offset: params?.offset,
									},
								}),
							),
						),
					() => legacySdk.sources.list(params),
				);
			},
			async resolve(identifier, type) {
				return withExperimentalFallback(
					async () =>
						normalizeExperimentalResolveSourcesResponse(
							unwrapExperimentalResponse(
								await client.sources.resolve.get({
									query: { identifier, type },
								}),
							),
						),
					() => legacySdk.sources.resolve(identifier, type),
				);
			},
		},
	};
}

/**
 * Configure the OpenAPI singleton without creating a full SDK instance.
 * Useful for validation calls (e.g., auth login) that only need low-level services.
 */
export function configureOpenApi(apiKey: string, baseUrl?: string): void {
	OpenAPI.BASE = baseUrl ?? DEFAULT_BASE_URL;
	OpenAPI.TOKEN = apiKey;
}

async function resolveClientContext(
	options: CreateSdkOptions,
): Promise<ResolvedClientContext> {
	const apiKey = await resolveApiKey(options.apiKey);

	if (!apiKey) {
		throw new Error(
			"No API key found. Run `nia auth login` to authenticate, " +
				"or set the NIA_API_KEY environment variable.",
		);
	}

	const [config, baseUrl] = await Promise.all([
		configStore.read(),
		resolveBaseUrl(options.baseUrl),
	]);

	return {
		apiKey,
		baseUrl,
		experimental: options.baseUrl
			? options.baseUrl === EXPERIMENTAL_BASE_URL
			: config.useExperimentalApi || baseUrl === EXPERIMENTAL_BASE_URL,
	};
}

function unwrapExperimentalResponse<T>(response: {
	data: T | null;
	error: unknown;
	status: number;
}): T {
	if (response.data !== null) {
		return response.data;
	}

	const status =
		isRecord(response.error) && typeof response.error.status === "number"
			? response.error.status
			: response.status;
	const body = isRecord(response.error) ? response.error.value : response.error;
	const error = new Error(extractExperimentalErrorMessage(body, status));
	(error as Error & { status?: number; body?: unknown }).status = status;
	(error as Error & { status?: number; body?: unknown }).body = body;
	throw error;
}

function extractExperimentalErrorMessage(
	body: unknown,
	status: number,
): string {
	if (typeof body === "string" && body.length > 0) {
		return body;
	}

	if (isRecord(body)) {
		if (typeof body.message === "string" && body.message.length > 0) {
			return body.message;
		}

		if (typeof body.summary === "string" && body.summary.length > 0) {
			return body.summary;
		}
	}

	return `Request failed with status ${status}`;
}

async function withExperimentalFallback<T>(
	runExperimental: () => Promise<T>,
	runLegacy: () => Promise<T>,
): Promise<T> {
	try {
		return await runExperimental();
	} catch (error) {
		if (shouldFallbackToLegacy(error)) {
			return runLegacy();
		}

		throw error;
	}
}

function shouldFallbackToLegacy(error: unknown): boolean {
	const status =
		error instanceof Error &&
		typeof (error as Error & { status?: unknown }).status === "number"
			? (error as Error & { status: number }).status
			: undefined;

	return (
		status === 404 ||
		status === 405 ||
		status === 500 ||
		status === 501 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

function toExperimentalCreateSourceBody(payload: Record<string, unknown>):
	| {
			type: "documentation" | "research_paper" | "huggingface_dataset";
			url: string;
			displayName?: string;
	  }
	| {
			type: "repository";
			repository: string;
			displayName?: string;
			ref?: string;
	  }
	| { type: "local_folder"; folderPath: string; displayName?: string } {
	const type = payload.type;
	const displayName = toOptionalString(payload.display_name);

	if (type === "repository") {
		return {
			type,
			repository: requiredString(
				payload.repository ?? payload.url,
				"repository",
			),
			displayName,
			ref: toOptionalString(payload.ref ?? payload.branch),
		};
	}

	if (type === "local_folder") {
		return {
			type,
			folderPath: requiredString(
				payload.folder_path ?? payload.path,
				"folderPath",
			),
			displayName,
		};
	}

	if (
		type === "documentation" ||
		type === "research_paper" ||
		type === "huggingface_dataset"
	) {
		return {
			type,
			url: requiredString(payload.url, "url"),
			displayName,
		};
	}

	throw new Error(
		`Experimental source indexing does not support type ${String(type)} yet.`,
	);
}

function requiresLegacyExperimentalSourceCreate(
	payload: Record<string, unknown>,
): boolean {
	const supportedKeys = new Set(["type", "url", "repository", "display_name"]);

	for (const key of Object.keys(payload)) {
		if (!supportedKeys.has(key) && payload[key] !== undefined) {
			return true;
		}
	}

	return payload.type !== "documentation" && payload.type !== "repository";
}

function normalizeExperimentalCreateSourceResponse(input: unknown): unknown {
	if (!isRecord(input) || !isRecord(input.source)) {
		return input;
	}

	return {
		action: input.action,
		...normalizeExperimentalSource(input.source),
	};
}

function normalizeExperimentalListSourcesResponse(input: unknown): unknown {
	if (!isRecord(input) || !Array.isArray(input.items)) {
		return input;
	}

	return {
		items: input.items.map((item) => normalizeExperimentalSource(item)),
		pagination: isRecord(input.pagination)
			? {
					total: input.pagination.total,
					limit: input.pagination.limit,
					offset: input.pagination.offset,
					has_more:
						typeof input.pagination.hasMore === "boolean"
							? input.pagination.hasMore
							: input.pagination.has_more,
				}
			: input.pagination,
	};
}

function normalizeExperimentalResolveSourcesResponse(input: unknown): unknown {
	if (!isRecord(input) || !Array.isArray(input.items)) {
		return input;
	}

	return {
		query: input.query,
		items: input.items.map((item) => normalizeExperimentalSource(item)),
	};
}

function normalizeExperimentalSource(input: unknown): Record<string, unknown> {
	if (!isRecord(input)) {
		return {};
	}

	return {
		id: input.id,
		type: input.type,
		identifier: input.identifier,
		display_name: input.displayName,
		status: input.status,
		created_at: input.createdAt,
		updated_at: input.updatedAt,
		visibility: input.visibility,
		readiness: input.readiness,
		is_global: input.isGlobal,
		global_source_id: input.globalSourceId,
		global_namespace: input.globalNamespace,
		metadata: input.metadata,
		capabilities: input.capabilities,
	};
}

function requiredString(value: unknown, label: string): string {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}

	throw new Error(`Missing required experimental source field: ${label}.`);
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
