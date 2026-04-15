import { readFileSync } from "node:fs";
import path from "node:path";
import { input } from "@crustjs/prompts";
import { annotate } from "@crustjs/skills";
import type { SourceCreateRequest } from "nia-ai-ts";
import {
	OpenAPI,
	V2ApiDataSourcesService,
	V2ApiSourcesService,
} from "nia-ai-ts";
import { app } from "../app.ts";
import { normalizeResolvedSourcesResponse } from "../services/compat/sources.ts";
import { resolveBaseUrl } from "../services/config.ts";
import {
	type CliSourceGrepBody,
	type CliSourceUpdatePayload,
	createCliSdk,
	createSdk,
} from "../services/sdk.ts";
import { createResponseError, withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Valid source type values accepted by the API.
 */
const SOURCE_TYPES = [
	"repository",
	"documentation",
	"research_paper",
	"huggingface_dataset",
	"local_folder",
] as const;

type SourceType = (typeof SOURCE_TYPES)[number];
type DocumentationSourceCreateRequest = SourceCreateRequest & {
	type: "documentation";
	extract_branding?: boolean;
};

type ResolvedSourceMatchRow = {
	id: string;
	type: string;
	name: string;
	identifier: string;
};

/**
 * Validate a source type flag value.
 * Returns the validated type or undefined if not provided.
 */
function validateSourceType(type: string | undefined): SourceType | undefined {
	if (!type) return undefined;
	if (SOURCE_TYPES.includes(type as SourceType)) {
		return type as SourceType;
	}
	console.error(
		`Invalid source type: "${type}". Allowed: ${SOURCE_TYPES.join(", ")}`,
	);
	process.exit(1);
}

function validateIndexUrl(url: string): string {
	try {
		new URL(url);
		return url;
	} catch {
		throw new Error(
			"Please provide a valid URL (for example, https://docs.example.com).",
		);
	}
}

/**
 * Resolve a positional path argument that might begin with a `-`.
 *
 * crustjs uses Node's `util.parseArgs` under the hood, which treats anything
 * starting with `-` as a flag — so positional paths like Claude Code session
 * file names (`-Users-arlanrakhmetzhanov-Developer-nia-app/sessions-index.json`)
 * fail to parse with "Missing required argument" before our `.run` handler
 * gets a chance to read them.
 *
 * The POSIX-standard escape hatch is `--`: everything after `--` is treated
 * as a raw positional. Node's parser respects this and crustjs surfaces the
 * raw values as `rawArgs`. We use a permissive (`required: false`) schema
 * so the parser doesn't error, then prefer `args[name]` (the normal path)
 * and fall back to `rawArgs[index]` for the `--` path.
 *
 * Throws a friendly error showing both calling conventions when neither is
 * present.
 */
function resolvePathArg(
	primary: string | undefined,
	rawArgs: readonly string[] | undefined,
	name: string,
	rawIndex = 0,
): string {
	const value = primary ?? rawArgs?.[rawIndex];
	if (!value) {
		throw new Error(
			`${name} is required.\n` +
				`  Standard: nia sources <cmd> <id> /concepts/foo.md\n` +
				`  For paths beginning with \`-\`: nia sources <cmd> <id> -- -Users-arlan/sessions-index.json`,
		);
	}
	return value;
}

async function resolveIndexUrl(url: string | undefined): Promise<string> {
	if (url) {
		return validateIndexUrl(url);
	}

	if (!process.stdin.isTTY) {
		throw new Error("URL is required when stdin is not a TTY.");
	}

	return input({
		message: "URL to index:",
		validate: (value: string) => {
			try {
				validateIndexUrl(value);
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
}

export function buildDocumentationSourceCreateRequest(input: {
	url: string;
	name?: string;
	branch?: string;
	focus?: string;
	extractBranding?: boolean;
	maxDepth?: number;
	checkLlmsTxt?: boolean;
	llmsTxtStrategy?: string;
	onlyMainContent?: boolean;
}): DocumentationSourceCreateRequest {
	const request: DocumentationSourceCreateRequest = {
		type: "documentation",
		url: input.url,
	};

	if (input.name) {
		request.display_name = input.name;
	}
	if (input.branch) {
		request.branch = input.branch;
	}
	if (input.focus) {
		request.focus_instructions = input.focus;
	}
	if (input.extractBranding !== undefined) {
		request.extract_branding = input.extractBranding;
	}
	if (input.maxDepth !== undefined) {
		request.max_depth = input.maxDepth;
	}
	if (input.checkLlmsTxt !== undefined) {
		request.check_llms_txt = input.checkLlmsTxt;
	}
	if (input.llmsTxtStrategy) {
		request.llms_txt_strategy = input.llmsTxtStrategy;
	}
	if (input.onlyMainContent !== undefined) {
		request.only_main_content = input.onlyMainContent;
	}

	return request;
}

export function buildResolvedSourceMatchRows(
	items: Array<{
		id?: string;
		type?: string;
		display_name?: string | null;
		displayName?: string | null;
		identifier?: string | null;
	}>,
): ResolvedSourceMatchRow[] {
	return items.map((item) => {
		const id = item.id ?? "";
		const displayName = item.display_name ?? item.displayName ?? null;

		return {
			id,
			type: item.type ?? "",
			name: displayName && displayName !== item.identifier ? displayName : "",
			identifier: item.identifier ?? "",
		};
	});
}

// --- Subcommands ---

const indexCommand = annotate(
	app
		.sub("index")
		.meta({
			description: "Index a documentation URL or website as a source",
		})
		.args([
			{
				name: "url",
				type: "string",
				description:
					"URL to index (prompted interactively if omitted in a TTY)",
			},
		] as const)
		.flags({
			name: {
				type: "string",
				description: "Display name for the source",
			},
			branch: {
				type: "string",
				description: "Git branch to index",
			},
			focus: {
				type: "string",
				description: "Focus instructions for LLM filtering",
			},
			"extract-branding": {
				type: "boolean",
				description: "Extract branding information",
			},
			"max-depth": {
				type: "number",
				description: "Maximum crawl depth (default: 20)",
			},
			"check-llms-txt": {
				type: "boolean",
				description: "Check for llms.txt file (default: true)",
			},
			"llms-txt-strategy": {
				type: "string",
				description:
					"How to use llms.txt: 'prefer' (llms.txt + crawl), 'only' (llms.txt only), 'ignore' (skip llms.txt)",
			},
			"only-main-content": {
				type: "boolean",
				description: "Extract only main content, skip navigation/footer",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });
			const url = await resolveIndexUrl(args.url);

			await withErrorHandling({ domain: "Source" }, async () => {
				const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

				const result = await cliSdk.sources.create(
					buildDocumentationSourceCreateRequest({
						url,
						name: flags.name,
						branch: flags.branch,
						focus: flags.focus,
						extractBranding: flags["extract-branding"],
						maxDepth: flags["max-depth"],
						checkLlmsTxt: flags["check-llms-txt"],
						llmsTxtStrategy: flags["llms-txt-strategy"],
						onlyMainContent: flags["only-main-content"],
					}),
				);

				fmt.output(result);
			});
		}),
	[
		"Always index the root link (e.g., `https://docs.stripe.com`) to scrape all pages.",
		"Indexing takes 1-5 minutes. Check status with `nia sources list`.",
		"Use `--focus` to provide LLM instructions for filtering relevant content.",
		"Use `--only-main-content` to skip navigation, headers, and footers.",
	],
);

const listCommand = app
	.sub("list")
	.meta({ description: "List indexed sources" })
	.flags({
		type: {
			type: "string",
			description:
				"Filter by type: repository, documentation, research_paper, huggingface_dataset",
		},
		query: {
			type: "string",
			description: "Search query to filter sources",
		},
		status: {
			type: "string",
			description: "Filter by indexing status",
		},
		category: {
			type: "string",
			description: "Filter by category ID",
		},
		limit: {
			type: "number",
			description: "Maximum number of results (default: 20)",
		},
		offset: {
			type: "number",
			description: "Offset for pagination",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		const sourceType = validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

			const result = await cliSdk.sources.list({
				type: sourceType,
				query: flags.query,
				status: flags.status,
				categoryId: flags.category,
				limit: flags.limit,
				offset: flags.offset,
			});

			fmt.output(result);
		});
	});

const getCommand = app
	.sub("get")
	.meta({ description: "Get details of a specific source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		const sourceType = validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const result = await cliSdk.sources.get(args.id, sourceType);

			fmt.output(result);
		});
	});

const resolveCommand = annotate(
	app
		.sub("resolve")
		.meta({ description: "Resolve a source by name, URL, or slug" })
		.args([
			{
				name: "identifier",
				type: "string",
				description: "Source identifier (name, URL, or slug)",
				required: true,
			},
		] as const)
		.flags({
			type: {
				type: "string",
				description:
					"Source type hint: repository, documentation, research_paper, huggingface_dataset",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			const sourceType = validateSourceType(flags.type);

			await withErrorHandling({ domain: "Source" }, async () => {
				const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

				const result = await cliSdk.sources.resolve(
					args.identifier,
					sourceType,
				);
				const normalized = normalizeResolvedSourcesResponse(result);

				if (fmt.format !== "text") {
					fmt.output(result);
					return;
				}

				if (normalized.items.length === 0) {
					fmt.info(
						`No source found for "${normalized.query ?? args.identifier}".`,
					);
					return;
				}

				if (normalized.items.length === 1) {
					fmt.output(normalized.items[0]);
					return;
				}

				fmt.info(
					`Found ${normalized.items.length} matches for "${normalized.query ?? args.identifier}".`,
				);
				fmt.output(buildResolvedSourceMatchRows(normalized.items), {
					columns: ["id", "type", "name", "identifier"],
				});
				fmt.info(
					"Refine the result with `nia search query` or use a source `id` for exact follow-up commands.",
				);
			});
		}),
	[
		"Accepts UUID, display name, or URL as the identifier.",
		"If multiple matches are returned, use `nia search query` to refine the core flow.",
		"Use `--type` to narrow the lookup when names are ambiguous across source types.",
	],
);

const updateCommand = app
	.sub("update")
	.meta({ description: "Update a source's display name or category" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		name: {
			type: "string",
			description: "New display name",
		},
		category: {
			type: "string",
			description: "Category ID to assign",
		},
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		const sourceType = validateSourceType(flags.type);

		if (!flags.name && !flags.category) {
			fmt.error("Provide at least one of --name or --category to update.");
			process.exit(1);
		}

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const requestBody: CliSourceUpdatePayload = {
				type: sourceType,
			};
			if (flags.name) {
				requestBody.displayName = flags.name;
			}
			if (flags.category) {
				requestBody.categoryId = flags.category;
			}

			const result = await cliSdk.sources.update(args.id, requestBody);

			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete an indexed source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		const sourceType = validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const result = await cliSdk.sources.delete(args.id, sourceType);

			fmt.output(result);
		});
	});

const syncCommand = app
	.sub("sync")
	.meta({
		description: "Re-index a source by resolving its URL and re-creating it",
	})
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		const sourceType = validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const sdk = await createSdk({ apiKey: flags["api-key"] });

			// Fetch the existing source to get its URL/identifier
			const source = await V2ApiSourcesService.getSourceV2SourcesSourceIdGet(
				args.id,
				sourceType,
			);

			const url = source.identifier;
			if (!url) {
				throw new Error(
					"Could not determine the source URL. The source may not have an identifier.",
				);
			}

			// Re-index by creating with the same URL
			const createRequest = {
				type: source.type ?? sourceType,
				url,
				display_name: source.display_name,
			};
			const result = await sdk.sources.create(createRequest);
			if (result?.id && source.id && result.id !== source.id) {
				await V2ApiSourcesService.deleteSourceV2SourcesSourceIdDelete(
					source.id,
					source.type ?? sourceType,
				);
			}

			fmt.output(result);
		});
	});

const renameCommand = app
	.sub("rename")
	.meta({ description: "Rename a source by identifier (name, URL, or UUID)" })
	.args([
		{
			name: "identifier",
			type: "string",
			description: "Source identifier (name, URL, or UUID)",
			required: true,
		},
		{
			name: "new-name",
			type: "string",
			description: "New display name",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiDataSourcesService.renameDataSourceV2V2DataSourcesRenamePatch(
					{
						identifier: args.identifier,
						new_name: args["new-name"],
					},
				);

			fmt.output(result);
		});
	});

// --- Content subcommands ---

const readCommand = app
	.sub("read")
	.meta({ description: "Read a file from an indexed source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			// Marked optional at the schema level so users can pass paths
			// that begin with `-` (e.g. Claude Code session files like
			// `-Users-arlanrakhmetzhanov-...`) via the POSIX `--` separator
			// without crustjs erroring out before we can read rawArgs.
			// Validated at runtime with a helpful error message via
			// resolvePathArg().
			name: "path",
			type: "string",
			description:
				"File path within the source. For paths beginning with `-`, pass after `--`: `nia sources read <id> -- -Users-arlan/sessions-index.json`",
		},
	] as const)
	.flags({
		"line-start": {
			type: "number",
			description: "Starting line number",
		},
		"line-end": {
			type: "number",
			description: "Ending line number",
		},
		"max-length": {
			type: "number",
			description: "Maximum content length to return",
		},
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags, rawArgs }) => {
		const fmt = createOutput({ color: flags.color });

		validateSourceType(flags.type);

		const filePath = resolvePathArg(args.path, rawArgs, "path");

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const result = await cliSdk.sources.content(args.id, {
				path: filePath,
				lineStart: flags["line-start"] ?? undefined,
				lineEnd: flags["line-end"] ?? undefined,
				maxLength: flags["max-length"] ?? undefined,
			});

			fmt.output(result);
		});
	});

const grepCommand = app
	.sub("grep")
	.meta({ description: "Search for a pattern in source files" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			name: "pattern",
			type: "string",
			description: "Search pattern (regex)",
			required: true,
		},
	] as const)
	.flags({
		path: {
			type: "string",
			description: "Filter by file path prefix",
		},
		"case-sensitive": {
			type: "boolean",
			description: "Enable case-sensitive matching",
		},
		"whole-word": {
			type: "boolean",
			description: "Match whole words only",
		},
		"lines-before": {
			type: "number",
			description: "Number of context lines before each match",
		},
		"lines-after": {
			type: "number",
			description: "Number of context lines after each match",
		},
		"max-per-file": {
			type: "number",
			description: "Maximum matches per file",
		},
		"max-total": {
			type: "number",
			description: "Maximum total matches",
		},
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const requestBody: CliSourceGrepBody = {
				pattern: args.pattern,
			};

			if (flags.path) {
				requestBody.path = flags.path;
			}
			if (flags["case-sensitive"] !== undefined) {
				requestBody.caseSensitive = flags["case-sensitive"];
			}
			if (flags["whole-word"] !== undefined) {
				requestBody.wholeWord = flags["whole-word"];
			}
			if (flags["lines-before"] !== undefined) {
				requestBody.linesBefore = flags["lines-before"];
			}
			if (flags["lines-after"] !== undefined) {
				requestBody.linesAfter = flags["lines-after"];
			}
			if (flags["max-per-file"] !== undefined) {
				requestBody.maxMatchesPerFile = flags["max-per-file"];
			}
			if (flags["max-total"] !== undefined) {
				requestBody.maxTotalMatches = flags["max-total"];
			}

			const result = await cliSdk.sources.grep(args.id, requestBody);

			fmt.output(result);
		});
	});

const treeCommand = app
	.sub("tree")
	.meta({ description: "View the file tree of an indexed source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		branch: {
			type: "string",
			description: "Branch or ref to inspect when supported by the backend",
		},
		"max-depth": {
			type: "number",
			description: "Maximum tree depth to return",
		},
		type: {
			type: "string",
			description:
				"Source type hint: repository, documentation, research_paper, huggingface_dataset",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
			const result = await cliSdk.sources.tree(args.id, {
				branch: flags.branch,
				maxDepth: flags["max-depth"] ?? undefined,
			});

			const treeString =
				typeof (result as { treeString?: unknown }).treeString === "string"
					? (result as { treeString: string }).treeString
					: typeof (result as { tree_string?: unknown }).tree_string ===
							"string"
						? (result as { tree_string: string }).tree_string
						: undefined;

			// If there's a tree string, show it directly in text mode for readability.
			if (treeString) {
				console.log(treeString);
			} else {
				fmt.output(result);
			}
		});
	});

const lsCommand = app
	.sub("ls")
	.meta({ description: "List files and directories in a source path" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
	] as const)
	.flags({
		path: {
			type: "string",
			description: "Directory path within the source (default: root)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiDataSourcesService.listDocumentationDirectoryV2V2DataSourcesSourceIdLsGet(
					args.id,
					flags.path,
				);

			fmt.output(result);
		});
	});

const subscribeCommand = annotate(
	app
		.sub("subscribe")
		.meta({
			description: "Subscribe to a public source for instant access",
		})
		.args([
			{
				name: "url",
				type: "string",
				description:
					"URL of the source (GitHub repo, docs URL, arXiv URL, or HuggingFace dataset)",
				required: true,
			},
		] as const)
		.flags({
			type: {
				type: "string",
				description:
					"Source type hint: repository, documentation, research_paper, huggingface_dataset",
			},
			ref: {
				type: "string",
				description: "Git ref for repositories (branch, tag, commit SHA)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Source" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });
				const baseUrl = await resolveBaseUrl();
				const token = OpenAPI.TOKEN;

				const body: Record<string, unknown> = { url: args.url };
				if (flags.type) {
					body.source_type = flags.type;
				}
				if (flags.ref) {
					body.ref = flags.ref;
				}

				const response = await fetch(`${baseUrl}/sources/subscribe`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});

				if (!response.ok) {
					throw await createResponseError(response, "Subscribe failed");
				}

				const result = (await response.json()) as Record<string, unknown>;
				fmt.output(result);
			});
		}),
	[
		"Subscribe to already-indexed global sources for instant access without re-indexing.",
		"Use when a source is already in the global pool — much faster than indexing from scratch.",
	],
);

const exploreCommand = annotate(
	app
		.sub("explore")
		.meta({
			description: "Browse globally indexed public sources",
		})
		.flags({
			query: {
				type: "string",
				description: "Search query to filter sources",
			},
			type: {
				type: "string",
				description:
					"Filter by type: repository, documentation, research_paper, huggingface_dataset",
			},
			sort: {
				type: "string",
				description:
					"Sort: recently_indexed, most_subscribed, most_tokens, relevance (default: most_subscribed)",
			},
			limit: {
				type: "number",
				description: "Maximum number of results (default: 20)",
			},
			offset: {
				type: "number",
				description: "Offset for pagination",
			},
		})
		.run(async ({ flags }) => {
			const fmt = createOutput({ color: flags.color });
			const sourceType = validateSourceType(flags.type);

			await withErrorHandling({ domain: "Source" }, async () => {
				const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
				const result = await cliSdk.sources.explore({
					search: flags.query,
					sourceType,
					sort: flags.sort ?? "most_subscribed",
					limit: flags.limit ?? 20,
					offset: flags.offset,
				});
				fmt.output(result);
			});
		}),
	[
		"Browse the global catalog of publicly indexed sources.",
		"Use `--query` to search by name, URL, or description.",
		"Subscribe to a source with `nia sources subscribe <url>` for instant access.",
	],
);

const writeCommand = app
	.sub("write")
	.meta({ description: "Write a file to an indexed source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			// See resolvePathArg() for the rationale on omitting `required`.
			name: "path",
			type: "string",
			description:
				"File path within the source. For paths beginning with `-`, pass after `--`.",
		},
	] as const)
	.flags({
		body: {
			type: "string",
			description: "Inline file content to write",
		},
		file: {
			type: "string",
			description: "Path to a local file whose content to upload",
		},
		encoding: {
			type: "string",
			description: "File encoding (default: utf8)",
		},
		language: {
			type: "string",
			description: "Programming language hint",
		},
	})
	.run(async ({ args, flags, rawArgs }) => {
		const fmt = createOutput({ color: flags.color });

		if (!flags.body && !flags.file) {
			fmt.error("Provide either --body or --file to specify file content.");
			process.exit(1);
		}

		const filePath = resolvePathArg(args.path, rawArgs, "path");

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			let content: string;
			if (flags.file) {
				content = readFileSync(flags.file, "utf8");
			} else {
				content = flags.body as string;
			}

			const body: Record<string, unknown> = {
				path: filePath,
				body: content,
			};
			if (flags.encoding) {
				body.encoding = flags.encoding;
			}
			if (flags.language) {
				body.language = flags.language;
			}

			const response = await fetch(`${baseUrl}/fs/${args.id}/files`, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw await createResponseError(response, "Write failed");
			}

			const result = (await response.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

const mvCommand = app
	.sub("mv")
	.meta({ description: "Move or rename a file in a source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			// See resolvePathArg() for the rationale on omitting `required`.
			name: "old-path",
			type: "string",
			description:
				"Current file path. For paths beginning with `-`, pass both paths after `--`.",
		},
		{
			name: "new-path",
			type: "string",
			description: "New file path within the source",
		},
	] as const)
	.run(async ({ args, flags, rawArgs }) => {
		const fmt = createOutput({ color: flags.color });

		const oldPath = resolvePathArg(args["old-path"], rawArgs, "old-path", 0);
		const newPath = resolvePathArg(args["new-path"], rawArgs, "new-path", 1);

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(`${baseUrl}/fs/${args.id}/mv`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					old_path: oldPath,
					new_path: newPath,
				}),
			});

			if (!response.ok) {
				throw await createResponseError(response, "Move failed");
			}

			const result = (await response.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

const mkdirCommand = app
	.sub("mkdir")
	.meta({ description: "Create a directory in a source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			// See resolvePathArg() for the rationale on omitting `required`.
			name: "path",
			type: "string",
			description:
				"Directory path to create. For paths beginning with `-`, pass after `--`.",
		},
	] as const)
	.run(async ({ args, flags, rawArgs }) => {
		const fmt = createOutput({ color: flags.color });

		const dirPath = resolvePathArg(args.path, rawArgs, "path");

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(`${baseUrl}/fs/${args.id}/mkdir`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ path: dirPath }),
			});

			if (!response.ok) {
				throw await createResponseError(response, "Create directory failed");
			}

			const result = (await response.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

const rmCommand = app
	.sub("rm")
	.meta({ description: "Delete a file from a source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Source ID",
			required: true,
		},
		{
			// See resolvePathArg() for the rationale on omitting `required`.
			name: "path",
			type: "string",
			description:
				"File path to delete. For paths beginning with `-`, pass after `--`.",
		},
	] as const)
	.run(async ({ args, flags, rawArgs }) => {
		const fmt = createOutput({ color: flags.color });

		const filePath = resolvePathArg(args.path, rawArgs, "path");

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(
				`${baseUrl}/fs/${args.id}/files?path=${encodeURIComponent(filePath)}`,
				{
					method: "DELETE",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				},
			);

			if (!response.ok) {
				throw await createResponseError(response, "Delete failed");
			}

			const result = (await response.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

const summaryCommand = app
	.sub("summary")
	.meta({ description: "Quick inventory of all source types" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(`${baseUrl}/sources-summary`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				throw await createResponseError(response, "Summary failed");
			}

			const result = (await response.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

const uploadCommand = app
	.sub("upload")
	.meta({ description: "Upload a PDF or file and create a source" })
	.args([
		{
			name: "file",
			type: "string",
			description: "Path to the local file to upload",
			required: true,
		},
	] as const)
	.flags({
		name: {
			type: "string",
			description: "Display name for the source",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const filePath = args.file;
			const fileName = path.basename(filePath);
			const ext = path.extname(filePath).toLowerCase();

			const contentTypeMap: Record<string, string> = {
				".pdf": "application/pdf",
				".csv": "text/csv",
				".xlsx":
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			};
			const contentType = contentTypeMap[ext] ?? "application/octet-stream";

			// Step 1: Get a signed upload URL
			const uploadUrlResponse = await fetch(`${baseUrl}/sources/upload-url`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					filename: fileName,
					content_type: contentType,
				}),
			});

			if (!uploadUrlResponse.ok) {
				throw await createResponseError(
					uploadUrlResponse,
					"Failed to get upload URL",
				);
			}

			const uploadUrlResult = (await uploadUrlResponse.json()) as {
				upload_url: string;
				gcs_path: string;
			};

			// Step 2: Upload the file content to the signed URL
			const fileContent = readFileSync(filePath);
			const uploadResponse = await fetch(uploadUrlResult.upload_url, {
				method: "PUT",
				headers: {
					"Content-Type": contentType,
				},
				body: fileContent,
			});

			if (!uploadResponse.ok) {
				throw await createResponseError(uploadResponse, "File upload failed");
			}

			// Step 3: Create the source with the GCS path
			const createBody: Record<string, unknown> = {
				gcs_path: uploadUrlResult.gcs_path,
			};
			if (flags.name) {
				createBody.display_name = flags.name;
			}

			const createResponse = await fetch(`${baseUrl}/sources`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(createBody),
			});

			if (!createResponse.ok) {
				throw await createResponseError(
					createResponse,
					"Source creation failed",
				);
			}

			const result = (await createResponse.json()) as Record<string, unknown>;
			fmt.output(result);
		});
	});

// --- Parent command ---

export const sourcesCommand = annotate(
	app
		.sub("sources")
		.meta({ description: "Manage indexed documentation and data sources" })
		.command(indexCommand)
		.command(listCommand)
		.command(getCommand)
		.command(resolveCommand)
		.command(updateCommand)
		.command(deleteCommand)
		.command(syncCommand)
		.command(renameCommand)
		.command(readCommand)
		.command(grepCommand)
		.command(treeCommand)
		.command(lsCommand)
		.command(subscribeCommand)
		.command(exploreCommand)
		.command(writeCommand)
		.command(mvCommand)
		.command(mkdirCommand)
		.command(rmCommand)
		.command(summaryCommand)
		.command(uploadCommand),
	[
		"Manages documentation, research papers, and HuggingFace datasets as indexed data sources.",
		"Most commands accept flexible identifiers: UUID, display name, or URL.",
		"Use `list` to check what's already indexed before indexing new sources.",
		"Use `tree` and `ls` to explore source structure, then `read` and `grep` for content.",
	],
);
