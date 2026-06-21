import { annotate } from "@crustjs/skills";
import type { CodeGrepRequest, RepositoryRequest } from "nia-ai-ts";
import { V2ApiRepositoriesService } from "nia-ai-ts";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Subcommands ---

const indexCommand = annotate(
	app
		.sub("index")
		.meta({ description: "Index a GitHub repository" })
		.args([
			{
				name: "repo",
				type: "string",
				description: "Repository in owner/repo format (e.g., vercel/ai)",
				required: true,
			},
		] as const)
		.flags({
			branch: {
				type: "string",
				short: "b",
				description:
					"Branch to index (defaults to the repository's default branch)",
			},
			ref: {
				type: "string",
				description:
					"Git ref to index (branch, tag, or commit SHA). Takes precedence over --branch",
			},
			name: {
				type: "string",
				description: "Custom display name for the repository",
			},
			private: {
				type: "boolean",
				description: "Index privately (don't add to global pool)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({
				color: flags.color,
				json: flags.json,
				output: flags.output,
			});

			await withErrorHandling({ domain: "Repository" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const requestBody: RepositoryRequest = {
					repository: args.repo,
				};

				if (flags.branch) {
					requestBody.branch = flags.branch;
				}
				if (flags.ref) {
					requestBody.ref = flags.ref;
				}
				if (flags.private !== undefined) {
					requestBody.add_as_global_source = !flags.private;
				}

				const result =
					await V2ApiRepositoriesService.indexRepositoryV2V2RepositoriesPost(
						requestBody,
					);

				fmt.output(result);
			});
		}),
	[
		"Indexing takes 1-5 minutes. Use `nia repos status` to check progress.",
		"Use `--private` to keep the repository private (not added to global pool).",
		"Repos are added to the global pool by default, making them searchable by all users.",
	],
);

const listCommand = app
	.sub("list")
	.meta({ description: "List indexed repositories" })
	.flags({
		query: {
			type: "string",
			description: "Filter by repository name (substring match)",
		},
		status: {
			type: "string",
			description: "Filter by indexing status",
		},
		limit: {
			type: "number",
			description: "Maximum number of results",
		},
		offset: {
			type: "number",
			description: "Offset for pagination",
		},
		all: {
			type: "boolean",
			default: false,
			description:
				"Fetch every page exhaustively. Use this instead of piping through `head` / `tail` when discovering repositories at scale.",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Repository" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			if (flags.all) {
				const items = await fetchAllRepositories({
					query: flags.query,
					status: flags.status,
				});
				fmt.output(items);
				return;
			}

			const result =
				await V2ApiRepositoriesService.listRepositoriesV2V2RepositoriesGet(
					flags.query,
					flags.status,
					flags.limit,
					flags.offset,
				);

			fmt.output(result);
		});
	});

/**
 * Page exhaustively through `V2ApiRepositoriesService.listRepositoriesV2V2RepositoriesGet`
 * until a page returns fewer items than the requested size. Page size and cap
 * mirror the analogous helper in `commands/sources.ts`.
 */
async function fetchAllRepositories(params: {
	query?: string;
	status?: string;
}): Promise<unknown[]> {
	const pageSize = 100;
	const maxPages = 50;
	const items: unknown[] = [];
	for (let page = 0; page < maxPages; page++) {
		const offset = page * pageSize;
		const result =
			await V2ApiRepositoriesService.listRepositoriesV2V2RepositoriesGet(
				params.query,
				params.status,
				pageSize,
				offset,
			);
		const batch = Array.isArray(result) ? result : [];
		items.push(...batch);
		if (batch.length < pageSize) {
			return items;
		}
	}
	return items;
}

const statusCommand = app
	.sub("status")
	.meta({ description: "Check the indexing status of a repository" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Repository ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Repository" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiRepositoriesService.getRepositoryStatusV2V2RepositoriesRepositoryIdGet(
					args.id,
				);

			// Show progress info if available
			if (result.progress) {
				const progress = result.progress as Record<string, unknown>;
				const percentage = progress.percentage;
				const stage = progress.stage;
				const progressMsg = progress.message;

				console.log(`Repository: ${result.repository}`);
				console.log(`Branch:     ${result.branch}`);
				console.log(`Status:     ${result.status}`);
				if (percentage !== undefined) {
					console.log(`Progress:   ${percentage}%`);
				}
				if (stage) {
					console.log(`Stage:      ${stage}`);
				}
				if (progressMsg) {
					console.log(`Message:    ${progressMsg}`);
				}
				if (result.error) {
					console.log(`Error:      ${result.error}`);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete an indexed repository" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Repository ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Repository" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiRepositoriesService.deleteRepositoryV2V2RepositoriesRepositoryIdDelete(
					args.id,
				);

			fmt.output(result);
		});
	});

const renameCommand = app
	.sub("rename")
	.meta({ description: "Rename an indexed repository" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Repository ID",
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
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Repository" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiRepositoriesService.renameRepositoryV2V2RepositoriesRepositoryIdRenamePatch(
					args.id,
					{ new_name: args["new-name"] },
				);

			fmt.output(result);
		});
	});

// --- Content subcommands ---

const readCommand = app
	.sub("read")
	.meta({ description: "Read file content from an indexed repository" })
	.args([
		{
			name: "repo-id",
			type: "string",
			description: "Repository ID",
			required: true,
		},
		{
			name: "path",
			type: "string",
			description: "File path within the repository",
			required: true,
		},
	] as const)
	.flags({
		branch: {
			type: "string",
			short: "b",
			description: "Branch name (defaults to the repository's default branch)",
		},
		ref: {
			type: "string",
			description:
				"Git ref (branch, tag, or commit SHA). Takes precedence over --branch",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Repository" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiRepositoriesService.getRepositoryContentV2V2RepositoriesRepositoryIdContentGet(
					args["repo-id"],
					args.path,
					flags.branch ?? undefined,
					flags.ref ?? undefined,
				);

			// Show file content with line numbers for readability
			if (result.success && result.content) {
				const lines = result.content.split("\n");
				const padding = String(lines.length).length;
				for (let i = 0; i < lines.length; i++) {
					const lineNum = String(i + 1).padStart(padding, " ");
					console.log(`${lineNum} | ${lines[i]}`);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const grepCommand = annotate(
	app
		.sub("grep")
		.meta({ description: "Search for a pattern in repository files" })
		.args([
			{
				name: "repo-id",
				type: "string",
				description: "Repository ID",
				required: true,
			},
			{
				name: "pattern",
				type: "string",
				description: "Search pattern (regex or fixed string)",
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
			"fixed-string": {
				type: "boolean",
				description: "Treat pattern as a literal string instead of regex",
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
			exhaustive: {
				type: "boolean",
				description: "Search all chunks for complete results (default: true)",
			},
			ref: {
				type: "string",
				description: "Git ref (branch, tag, or commit SHA)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({
				color: flags.color,
				json: flags.json,
				output: flags.output,
			});

			await withErrorHandling({ domain: "Repository" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const requestBody: CodeGrepRequest = {
					pattern: args.pattern,
				};

				if (flags.path) {
					requestBody.path = flags.path;
				}
				if (flags.ref) {
					requestBody.ref = flags.ref;
				}
				if (flags["case-sensitive"] !== undefined) {
					requestBody.case_sensitive = flags["case-sensitive"];
				}
				if (flags["whole-word"] !== undefined) {
					requestBody.whole_word = flags["whole-word"];
				}
				if (flags["fixed-string"] !== undefined) {
					requestBody.fixed_string = flags["fixed-string"];
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
				if (flags.exhaustive !== undefined) {
					requestBody.exhaustive = flags.exhaustive;
				}

				const result =
					await V2ApiRepositoriesService.grepRepositoryV2V2RepositoriesRepositoryIdGrepPost(
						args["repo-id"],
						requestBody,
					);

				fmt.output(result);
			});
		}),
	[
		"Supports regex patterns by default. Use `--fixed-string` for literal string matching.",
		"Use `--path` to narrow search to a specific directory or file prefix.",
		"Use `--ref` to search a specific branch, tag, or commit.",
	],
);

const treeCommand = annotate(
	app
		.sub("tree")
		.meta({ description: "View the file tree of an indexed repository" })
		.args([
			{
				name: "repo-id",
				type: "string",
				description: "Repository ID",
				required: true,
			},
		] as const)
		.flags({
			branch: {
				type: "string",
				short: "b",
				description: "Branch name",
			},
			"include-paths": {
				type: "string",
				description: "Comma-separated path prefixes to include",
			},
			"exclude-paths": {
				type: "string",
				description: "Comma-separated path prefixes to exclude",
			},
			extensions: {
				type: "string",
				description: "Comma-separated file extensions to include (e.g., ts,js)",
			},
			"exclude-extensions": {
				type: "string",
				description: "Comma-separated file extensions to exclude",
			},
			"full-paths": {
				type: "boolean",
				description: "Show full file paths instead of tree structure",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({
				color: flags.color,
				json: flags.json,
				output: flags.output,
			});

			await withErrorHandling({ domain: "Repository" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const result =
					await V2ApiRepositoriesService.getRepositoryTreeV2V2RepositoriesRepositoryIdTreeGet(
						args["repo-id"],
						flags.branch ?? undefined,
						flags["include-paths"] ?? undefined,
						flags["exclude-paths"] ?? undefined,
						flags.extensions ?? undefined,
						flags["exclude-extensions"] ?? undefined,
						flags["full-paths"] ?? undefined,
					);

				// If there's a tree_text, show it directly for readability
				if (result.tree_text) {
					console.log(result.tree_text);

					// Show stats summary if available
					if (result.stats) {
						const stats = result.stats as Record<string, unknown>;
						const parts: string[] = [];
						if (stats.total_files !== undefined) {
							parts.push(`${stats.total_files} files`);
						}
						if (stats.total_directories !== undefined) {
							parts.push(`${stats.total_directories} directories`);
						}
						if (parts.length > 0) {
							console.log(`\n${parts.join(", ")}`);
						}
					}
				} else {
					fmt.output(result);
				}
			});
		}),
	[
		"Use tree first to understand the repository structure before reading or grepping files.",
		"Filter with `--extensions` and `--include-paths`/`--exclude-paths` to reduce noise.",
	],
);

// --- Parent command ---

export const reposCommand = annotate(
	app
		.sub("repos")
		.meta({ description: "Manage indexed repositories" })
		.command(indexCommand)
		.command(listCommand)
		.command(statusCommand)
		.command(deleteCommand)
		.command(renameCommand)
		.command(readCommand)
		.command(grepCommand)
		.command(treeCommand),
	[
		"Use for managing and searching GitHub repositories that have been indexed by Nia.",
		"For live GitHub access without indexing, use `nia github` instead.",
		"Prefer `tree` before `read`/`grep` to understand repository structure.",
		"For source DISCOVERY, prefer `nia project status` (if a `nia.json` is present) or `nia sources summary`. Only run `nia repos list --all` when you genuinely need to enumerate every repo — never pipe through `head` / `tail`, you'll miss matches.",
	],
);
