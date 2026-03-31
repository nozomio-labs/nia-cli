import { createClient } from "@nozomioai/nia-sdk";
import {
	NiaSDK,
	OpenAPI,
	V2ApiDataSourcesService,
	V2ApiSourcesService,
} from "nia-ai-ts";
import {
	configStore,
	DEFAULT_BASE_URL,
	EXPERIMENTAL_BASE_URL,
	getExperimentalOverride,
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

type SearchMessageRole = "user" | "assistant" | "system";

export interface CliSourceUpdatePayload {
	displayName?: string | null;
	categoryId?: string | null;
	type?: SourceType;
}

export interface CliSourceTreeQuery {
	branch?: string;
	maxDepth?: number;
}

export interface CliSourceContentQuery {
	path?: string;
	url?: string;
	branch?: string;
	page?: number;
	treeNodeId?: string;
	lineStart?: number;
	lineEnd?: number;
	maxLength?: number;
}

export interface CliSourceGrepBody {
	pattern: string;
	path?: string;
	ref?: string;
	treeNodeId?: string;
	pageStart?: number;
	pageEnd?: number;
	contextLines?: number;
	linesAfter?: number;
	linesBefore?: number;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	fixedString?: boolean;
	maxMatchesPerFile?: number;
	maxTotalMatches?: number;
	outputMode?: "content" | "files_with_matches" | "count";
	highlight?: boolean;
	includeLineNumbers?: boolean;
	groupByFile?: boolean;
	exhaustive?: boolean;
}

export interface CliSearchQueryPayload {
	mode: "query";
	messages: Array<{
		role: SearchMessageRole;
		content: string;
	}>;
	sources: Array<{ id: string } | { identifier: string; type: SourceType }>;
	options?: {
		skipReranking?: boolean;
		skipMultiQuery?: boolean;
		skipTreeSearch?: boolean;
		skipFollowUp?: boolean;
		skipCache?: boolean;
	};
}

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
		get(id: string, type?: SourceType): Promise<unknown>;
		update(id: string, payload: CliSourceUpdatePayload): Promise<unknown>;
		delete(id: string, type?: SourceType): Promise<unknown>;
		tree(id: string, query?: CliSourceTreeQuery): Promise<unknown>;
		content(id: string, query?: CliSourceContentQuery): Promise<unknown>;
		grep(id: string, payload: CliSourceGrepBody): Promise<unknown>;
	};
	search: {
		query(payload: Record<string, unknown>): Promise<unknown>;
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

	const legacySdk = new NiaSDK({
		apiKey: context.apiKey,
		baseUrl: context.baseUrl,
	});
	const legacyGetSource = async (
		id: string,
		type?: SourceType,
	): Promise<unknown> => V2ApiSourcesService.getSourceV2SourcesSourceIdGet(id, type);
	const legacyUpdateSource = async (
		id: string,
		payload: CliSourceUpdatePayload,
	): Promise<unknown> =>
		V2ApiSourcesService.updateSourceV2SourcesSourceIdPatch(
			id,
			toLegacyUpdateSourceBody(payload) as Parameters<
				typeof V2ApiSourcesService.updateSourceV2SourcesSourceIdPatch
			>[1],
			payload.type,
		);
	const legacyDeleteSource = async (
		id: string,
		type?: SourceType,
	): Promise<unknown> =>
		V2ApiSourcesService.deleteSourceV2SourcesSourceIdDelete(id, type);
	const legacyTree = async (id: string): Promise<unknown> =>
		V2ApiDataSourcesService.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet(
			id,
		);
	const legacyContent = async (
		id: string,
		query: CliSourceContentQuery = {},
	): Promise<unknown> =>
		V2ApiDataSourcesService.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
			id,
			query.path ?? "",
			query.page,
			query.treeNodeId,
			query.lineStart,
			query.lineEnd,
			query.maxLength,
		);
	const legacyGrep = async (
		id: string,
		payload: CliSourceGrepBody,
	): Promise<unknown> =>
		V2ApiDataSourcesService.grepDocumentationV2V2DataSourcesSourceIdGrepPost(
			id,
			toLegacyGrepBody(payload) as Parameters<
				typeof V2ApiDataSourcesService.grepDocumentationV2V2DataSourcesSourceIdGrepPost
			>[1],
		);
	const legacyQuerySearch = async (
		payload: Record<string, unknown>,
	): Promise<unknown> => legacySdk.search.query(payload as never);
	const getLegacyUsageSummary = async (): Promise<unknown> => {
		const { V2ApiService } = await import("nia-ai-ts");
		return V2ApiService.getUsageSummaryV2V2UsageGet();
	};

	if (!context.experimental) {
		return {
			experimental: false,
			usage: {
				getSummary: getLegacyUsageSummary,
			},
			sources: {
				create(payload) {
					return legacySdk.sources.create(payload);
				},
				list(params) {
					return legacySdk.sources.list(params);
				},
				resolve(identifier, type) {
					return legacySdk.sources.resolve(identifier, type);
				},
				get(id, type) {
					return legacyGetSource(id, type);
				},
				update(id, payload) {
					return legacyUpdateSource(id, payload);
				},
				delete(id, type) {
					return legacyDeleteSource(id, type);
				},
				tree(id) {
					return legacyTree(id);
				},
				content(id, query) {
					return legacyContent(id, query);
				},
				grep(id, payload) {
					return legacyGrep(id, payload);
				},
			},
			search: {
				query(payload) {
					return legacyQuerySearch(payload);
				},
			},
		};
	}

	const client = createClient(context.baseUrl, {
		apiKey: context.apiKey,
	});

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
						unwrapExperimentalResponse(
							await client.sources.post(toExperimentalCreateSourceBody(payload)),
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
					() => legacySdk.sources.list(params),
				);
			},
			async resolve(identifier, type) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.sources.resolve.get({
								query: { identifier, type },
							}),
						),
					() => legacySdk.sources.resolve(identifier, type),
				);
			},
			async get(id, type) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(await client.sources({ id }).get()),
					() => legacyGetSource(id, type),
				);
			},
			async update(id, payload) {
				if (requiresLegacyExperimentalSourceUpdate(payload)) {
					return legacyUpdateSource(id, payload);
				}

				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.sources({ id }).patch(
								toExperimentalUpdateSourceBody(payload),
							),
						),
					() => legacyUpdateSource(id, payload),
				);
			},
			async delete(id, type) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(await client.sources({ id }).delete()),
					() => legacyDeleteSource(id, type),
				);
			},
			async tree(id, query) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.sources({ id }).tree.get({
								query: {
									branch: query?.branch,
									maxDepth: query?.maxDepth,
								},
							}),
						),
					() => legacyTree(id),
				);
			},
			async content(id, query) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.sources({ id }).content.get({
								query: {
									path: query?.path,
									url: query?.url,
									branch: query?.branch,
									page: query?.page,
									treeNodeId: query?.treeNodeId,
									lineStart: query?.lineStart,
									lineEnd: query?.lineEnd,
									maxLength: query?.maxLength,
								},
							}),
						),
					() => legacyContent(id, query),
				);
			},
			async grep(id, payload) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.sources({ id }).grep.post(payload),
						),
					() => legacyGrep(id, payload),
				);
			},
		},
		search: {
			async query(payload) {
				return withExperimentalFallback(
					async () =>
						unwrapExperimentalResponse(
							await client.search.post(payload as CliSearchQueryPayload),
						),
					() => legacyQuerySearch(toLegacySearchQueryPayload(payload)),
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
			: getExperimentalOverride() ??
				(config.useExperimentalApi || baseUrl === EXPERIMENTAL_BASE_URL),
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
			config?: string;
			addAsGlobalSource?: boolean;
			urlPatterns?: string[];
			excludePatterns?: string[];
			projectId?: string;
			maxDepth?: number;
			limit?: number;
			crawlEntireDomain?: boolean;
			onlyMainContent?: boolean;
			waitFor?: number;
			includeScreenshot?: boolean;
			checkLlmsTxt?: boolean;
			llmsTxtStrategy?: string;
			isPdf?: boolean;
			gcsPath?: string;
			focusInstructions?: string;
			extractBranding?: boolean;
			extractImages?: boolean;
	  }
	| {
			type: "repository";
			repository: string;
			displayName?: string;
			branch?: string;
			ref?: string;
	  }
	| {
			type: "local_folder";
			folderPath?: string;
			displayName?: string;
			files?: Array<{ path: string; content: string }>;
			database?: { filename: string; content: string };
	  } {
	const type = payload.type;
	const displayName = toOptionalString(
		payload.display_name ?? payload.displayName,
	);

	if (type === "repository") {
		return {
			type,
			repository: requiredString(
				payload.repository ?? payload.url,
				"repository",
			),
			displayName,
			branch: toOptionalString(payload.branch),
			ref: toOptionalString(payload.ref ?? payload.branch),
		};
	}

	if (type === "local_folder") {
		return {
			type,
			folderPath: toOptionalString(payload.folder_path ?? payload.path),
			displayName,
			files: toOptionalSourceFiles(payload.files),
			database: toOptionalDatabase(payload.database),
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
			config: toOptionalString(payload.config),
			addAsGlobalSource: toOptionalBoolean(payload.add_as_global_source),
			urlPatterns: toOptionalStringArray(payload.url_patterns),
			excludePatterns: toOptionalStringArray(payload.exclude_patterns),
			projectId: toOptionalString(payload.project_id),
			maxDepth: toOptionalNumber(payload.max_depth),
			limit: toOptionalNumber(payload.limit),
			crawlEntireDomain: toOptionalBoolean(payload.crawl_entire_domain),
			onlyMainContent: toOptionalBoolean(payload.only_main_content),
			waitFor: toOptionalNumber(payload.wait_for),
			includeScreenshot: toOptionalBoolean(payload.include_screenshot),
			checkLlmsTxt: toOptionalBoolean(payload.check_llms_txt),
			llmsTxtStrategy: toOptionalString(payload.llms_txt_strategy),
			isPdf: toOptionalBoolean(payload.is_pdf),
			gcsPath: toOptionalString(payload.gcs_path),
			focusInstructions: toOptionalString(payload.focus_instructions),
			extractBranding: toOptionalBoolean(payload.extract_branding),
			extractImages: toOptionalBoolean(payload.extract_images),
		};
	}

	throw new Error(
		`Experimental source indexing does not support type ${String(type)} yet.`,
	);
}

function requiresLegacyExperimentalSourceCreate(
	payload: Record<string, unknown>,
): boolean {
	const supportedKeys = new Set([
		"type",
		"url",
		"repository",
		"display_name",
		"displayName",
		"branch",
		"ref",
		"config",
		"add_as_global_source",
		"url_patterns",
		"exclude_patterns",
		"project_id",
		"max_depth",
		"limit",
		"crawl_entire_domain",
		"only_main_content",
		"wait_for",
		"include_screenshot",
		"check_llms_txt",
		"llms_txt_strategy",
		"is_pdf",
		"gcs_path",
		"focus_instructions",
		"extract_branding",
		"extract_images",
		"folder_path",
		"path",
		"files",
		"database",
	]);

	for (const key of Object.keys(payload)) {
		if (!supportedKeys.has(key) && payload[key] !== undefined) {
			return true;
		}
	}

	return (
		payload.type !== "documentation" &&
		payload.type !== "repository" &&
		payload.type !== "research_paper" &&
		payload.type !== "huggingface_dataset" &&
		payload.type !== "local_folder"
	);
}

function requiresLegacyExperimentalSourceUpdate(
	payload: CliSourceUpdatePayload,
): boolean {
	return payload.categoryId !== undefined;
}

function toExperimentalUpdateSourceBody(
	payload: CliSourceUpdatePayload,
): { displayName?: string | null } {
	const body: { displayName?: string | null } = {};
	if (payload.displayName !== undefined) {
		body.displayName = payload.displayName;
	}
	return body;
}

function toLegacyUpdateSourceBody(
	payload: CliSourceUpdatePayload,
): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (payload.displayName !== undefined) {
		body.display_name = payload.displayName;
	}
	if (payload.categoryId !== undefined) {
		body.category_id = payload.categoryId;
	}
	return body;
}

function toLegacyGrepBody(payload: CliSourceGrepBody): Record<string, unknown> {
	const body: Record<string, unknown> = {
		pattern: payload.pattern,
	};

	if (payload.path !== undefined) {
		body.path = payload.path;
	}
	if (payload.caseSensitive !== undefined) {
		body.case_sensitive = payload.caseSensitive;
	}
	if (payload.wholeWord !== undefined) {
		body.whole_word = payload.wholeWord;
	}
	if (payload.linesBefore !== undefined) {
		body.B = payload.linesBefore;
	} else if (payload.contextLines !== undefined) {
		body.B = payload.contextLines;
	}
	if (payload.linesAfter !== undefined) {
		body.A = payload.linesAfter;
	} else if (payload.contextLines !== undefined) {
		body.A = payload.contextLines;
	}
	if (payload.maxMatchesPerFile !== undefined) {
		body.max_matches_per_file = payload.maxMatchesPerFile;
	}
	if (payload.maxTotalMatches !== undefined) {
		body.max_total_matches = payload.maxTotalMatches;
	}

	return body;
}

function toLegacySearchQueryPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (!isQuerySearchPayload(payload)) {
		return payload;
	}

	const repositories: string[] = [];
	const dataSources: string[] = [];
	const localFolders: string[] = [];

	for (const source of payload.sources) {
		if (!isRecord(source) || typeof source.identifier !== "string") {
			continue;
		}
		switch (source.type) {
			case "repository":
				repositories.push(source.identifier);
				break;
			case "local_folder":
				localFolders.push(source.identifier);
				break;
			default:
				dataSources.push(source.identifier);
		}
	}

	const legacyPayload: Record<string, unknown> = {
		messages: payload.messages,
		search_mode: inferLegacySearchMode({
			repositories,
			dataSources,
			localFolders,
		}),
	};
	if (repositories.length > 0) {
		legacyPayload.repositories = repositories;
	}
	if (dataSources.length > 0) {
		legacyPayload.data_sources = dataSources;
	}
	if (localFolders.length > 0) {
		legacyPayload.local_folders = localFolders;
	}

	return legacyPayload;
}

function inferLegacySearchMode(input: {
	repositories: string[];
	dataSources: string[];
	localFolders: string[];
}): string {
	const hasRepos = input.repositories.length > 0;
	const hasSources = input.dataSources.length > 0 || input.localFolders.length > 0;

	if (hasRepos && !hasSources) {
		return "repositories";
	}
	if (!hasRepos && hasSources) {
		return "sources";
	}
	return "unified";
}

function isQuerySearchPayload(
	value: Record<string, unknown>,
): value is CliSearchQueryPayload {
	return (
		value.mode === "query" &&
		Array.isArray(value.messages) &&
		Array.isArray(value.sources)
	);
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

function toOptionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toOptionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return items.length > 0 ? items : undefined;
}

function toOptionalSourceFiles(
	value: unknown,
): Array<{ path: string; content: string }> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const files = value.flatMap((item) => {
		if (!isRecord(item)) {
			return [];
		}
		if (typeof item.path !== "string" || typeof item.content !== "string") {
			return [];
		}
		return [{ path: item.path, content: item.content }];
	});
	return files.length > 0 ? files : undefined;
}

function toOptionalDatabase(
	value: unknown,
): { filename: string; content: string } | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.filename !== "string" || typeof value.content !== "string") {
		return undefined;
	}
	return {
		filename: value.filename,
		content: value.content,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
