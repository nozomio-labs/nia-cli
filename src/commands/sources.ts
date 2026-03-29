import { input } from "@crustjs/prompts";
import { annotate } from "@crustjs/skills";
import type { GrepRequest, SourceCreateRequest } from "nia-ai-ts";
import { V2ApiDataSourcesService, V2ApiSourcesService } from "nia-ai-ts";
import { app } from "../app.ts";
import { normalizeResolvedSourcesResponse } from "../services/compat/sources.ts";
import { createCliSdk, createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
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
		identifier?: string | null;
	}>,
): ResolvedSourceMatchRow[] {
	return items.map((item) => {
		const id = item.id ?? "";

		return {
			id,
			type: item.type ?? "",
			name:
				item.display_name && item.display_name !== item.identifier
					? item.display_name
					: "",
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
			await createSdk({ apiKey: flags["api-key"] });

			const result = await V2ApiSourcesService.getSourceV2SourcesSourceIdGet(
				args.id,
				sourceType,
			);

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
			await createSdk({ apiKey: flags["api-key"] });

			const requestBody: Record<string, unknown> = {};
			if (flags.name) {
				requestBody.display_name = flags.name;
			}
			if (flags.category) {
				requestBody.category_id = flags.category;
			}

			const result =
				await V2ApiSourcesService.updateSourceV2SourcesSourceIdPatch(
					args.id,
					requestBody as Parameters<
						typeof V2ApiSourcesService.updateSourceV2SourcesSourceIdPatch
					>[1],
					sourceType,
				);

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
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiSourcesService.deleteSourceV2SourcesSourceIdDelete(
					args.id,
					sourceType,
				);

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
			name: "path",
			type: "string",
			description: "File path within the source",
			required: true,
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
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		validateSourceType(flags.type);

		await withErrorHandling({ domain: "Source" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiDataSourcesService.readDocumentationFileV2V2DataSourcesSourceIdReadGet(
					args.id,
					args.path,
					undefined, // page
					undefined, // treeNodeId
					flags["line-start"] ?? undefined,
					flags["line-end"] ?? undefined,
					flags["max-length"] ?? undefined,
				);

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
			await createSdk({ apiKey: flags["api-key"] });

			const requestBody: GrepRequest = {
				pattern: args.pattern,
			};

			if (flags.path) {
				requestBody.path = flags.path;
			}
			if (flags["case-sensitive"] !== undefined) {
				requestBody.case_sensitive = flags["case-sensitive"];
			}
			if (flags["whole-word"] !== undefined) {
				requestBody.whole_word = flags["whole-word"];
			}
			if (flags["lines-before"] !== undefined) {
				requestBody.B = flags["lines-before"];
			}
			if (flags["lines-after"] !== undefined) {
				requestBody.A = flags["lines-after"];
			}
			if (flags["max-per-file"] !== undefined) {
				requestBody.max_matches_per_file = flags["max-per-file"];
			}
			if (flags["max-total"] !== undefined) {
				requestBody.max_total_matches = flags["max-total"];
			}

			const result =
				await V2ApiDataSourcesService.grepDocumentationV2V2DataSourcesSourceIdGrepPost(
					args.id,
					requestBody,
				);

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
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiDataSourcesService.getDocumentationTreeV2V2DataSourcesSourceIdTreeGet(
					args.id,
				);

			// If there's a tree_string, show it directly in text mode for readability
			if (result.tree_string) {
				console.log(result.tree_string);
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
		.command(lsCommand),
	[
		"Manages documentation, research papers, and HuggingFace datasets as indexed data sources.",
		"Most commands accept flexible identifiers: UUID, display name, or URL.",
		"Use `list` to check what's already indexed before indexing new sources.",
		"Use `tree` and `ls` to explore source structure, then `read` and `grep` for content.",
	],
);
