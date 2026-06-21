import { annotate } from "@crustjs/skills";
import type {
	GitHubGlobRequest,
	GitHubReadRequest,
	GitHubSearchRequest,
} from "nia-ai-ts";
import { GithubSearchService } from "nia-ai-ts";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Parse a "owner/repo" string into separate owner and repo parts.
 * Throws a user-friendly error if the format is invalid.
 */
function parseOwnerRepo(input: string): { owner: string; repo: string } {
	const parts = input.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		console.error(
			`Invalid repository format: "${input}". Expected "owner/repo" (e.g., "vercel/next.js").`,
		);
		process.exit(1);
	}
	return { owner: parts[0], repo: parts[1] };
}

// --- Subcommands ---

const globCommand = app
	.sub("glob")
	.meta({
		description: "Find files matching a glob pattern in a GitHub repository",
	})
	.args([
		{
			name: "repo",
			type: "string",
			description: "Repository in owner/repo format (e.g., vercel/next.js)",
			required: true,
		},
		{
			name: "pattern",
			type: "string",
			description: "Glob pattern (e.g., '*.py', 'src/**/*.ts')",
			required: true,
		},
	] as const)
	.flags({
		ref: {
			type: "string",
			description: "Branch, tag, or commit SHA",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "GitHub" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: GitHubGlobRequest = {
				repository: args.repo,
				pattern: args.pattern,
			};

			if (flags.ref) {
				payload.ref = flags.ref;
			}

			const result =
				await GithubSearchService.githubGlobV2GithubGlobPost(payload);

			// In text mode, display as a file list
			const data = result as Record<string, unknown>;
			const files = data.files ?? data.matches ?? data.results;
			if (Array.isArray(files)) {
				if (files.length === 0) {
					console.log("No files matching the pattern.");
				} else {
					for (const file of files) {
						console.log(
							typeof file === "string"
								? file
								: String((file as Record<string, unknown>).path ?? file),
						);
					}
					console.log(`\n${files.length} file(s) found`);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const readCommand = app
	.sub("read")
	.meta({
		description:
			"Read a file from a GitHub repository with optional line range",
	})
	.args([
		{
			name: "repo",
			type: "string",
			description: "Repository in owner/repo format (e.g., vercel/next.js)",
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
		ref: {
			type: "string",
			description: "Branch, tag, or commit SHA",
		},
		start: {
			type: "number",
			description: "Start line number (1-based)",
		},
		end: {
			type: "number",
			description: "End line number (1-based, inclusive)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "GitHub" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: GitHubReadRequest = {
				repository: args.repo,
				path: args.path,
			};

			if (flags.ref) {
				payload.ref = flags.ref;
			}
			if (flags.start !== undefined) {
				payload.start_line = flags.start;
			}
			if (flags.end !== undefined) {
				payload.end_line = flags.end;
			}

			const result =
				await GithubSearchService.githubReadV2GithubReadPost(payload);

			// In text mode, display file content with line numbers
			const data = result as Record<string, unknown>;
			if (typeof data.content === "string") {
				const lines = data.content.split("\n");
				const startLine = flags.start ?? 1;
				const padWidth = String(startLine + lines.length - 1).length;
				for (let i = 0; i < lines.length; i++) {
					const lineNum = String(startLine + i).padStart(padWidth, " ");
					console.log(`${lineNum} | ${lines[i]}`);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const searchCommand = annotate(
	app
		.sub("search")
		.meta({
			description:
				"Search code in a GitHub repository (rate limited to 10 requests/minute by GitHub)",
		})
		.args([
			{
				name: "repo",
				type: "string",
				description: "Repository in owner/repo format (e.g., vercel/next.js)",
				required: true,
			},
			{
				name: "query",
				type: "string",
				description: "Code search query",
				required: true,
			},
		] as const)
		.flags({
			"per-page": {
				type: "number",
				description: "Results per page",
			},
			page: {
				type: "number",
				description: "Page number",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({
				color: flags.color,
				json: flags.json,
				output: flags.output,
			});

			await withErrorHandling({ domain: "GitHub" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: GitHubSearchRequest = {
					query: args.query,
					repository: args.repo,
				};

				if (flags["per-page"] !== undefined) {
					payload.per_page = flags["per-page"];
				}
				if (flags.page !== undefined) {
					payload.page = flags.page;
				}

				const result =
					await GithubSearchService.githubCodeSearchV2GithubSearchPost(payload);

				// In text mode, display search results with file paths and matched lines
				const data = result as Record<string, unknown>;
				const items = data.items ?? data.results ?? data.matches;
				if (Array.isArray(items)) {
					if (items.length === 0) {
						console.log("No matching code found.");
					} else {
						for (const item of items) {
							const entry = item as Record<string, unknown>;
							const path = entry.path ?? entry.file ?? entry.name ?? "";
							console.log(`${path}`);
							if (entry.text_matches && Array.isArray(entry.text_matches)) {
								for (const match of entry.text_matches as Array<
									Record<string, unknown>
								>) {
									if (match.fragment) {
										console.log(`  ${match.fragment}`);
									}
								}
							}
						}
						console.log(`\n${items.length} result(s) found`);
					}
				} else {
					fmt.output(result);
				}
			});
		}),
	[
		"Rate limited to 10 requests/minute by GitHub.",
		"For indexed repository search, use `nia repos grep` instead (faster and unlimited).",
	],
);

const treeCommand = app
	.sub("tree")
	.meta({
		description: "Get the file tree of a GitHub repository or subdirectory",
	})
	.args([
		{
			name: "repo",
			type: "string",
			description: "Repository in owner/repo format (e.g., vercel/next.js)",
			required: true,
		},
	] as const)
	.flags({
		ref: {
			type: "string",
			description: "Branch, tag, or commit SHA",
		},
		path: {
			type: "string",
			description: "Subdirectory path",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		const { owner, repo } = parseOwnerRepo(args.repo);

		await withErrorHandling({ domain: "GitHub" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await GithubSearchService.githubTreeV2GithubTreeOwnerRepoGet(
					owner,
					repo,
					flags.ref ?? undefined,
					flags.path ?? undefined,
				);

			// In text mode, show tree_text directly if available
			const data = result as Record<string, unknown>;
			if (typeof data.tree_text === "string") {
				console.log(data.tree_text);
				// Show stats if available
				const stats = data.stats as Record<string, unknown> | undefined;
				if (stats) {
					const parts: string[] = [];
					if (stats.total_files !== undefined) {
						parts.push(`${stats.total_files} file(s)`);
					}
					if (stats.total_directories !== undefined) {
						parts.push(
							`${stats.total_directories} director${stats.total_directories === 1 ? "y" : "ies"}`,
						);
					}
					if (parts.length > 0) {
						console.log(`\n${parts.join(", ")}`);
					}
				}
			} else if (typeof data.tree === "string") {
				console.log(data.tree);
			} else {
				fmt.output(result);
			}
		});
	});

export const githubCommand = annotate(
	app
		.sub("github")
		.meta({
			description: "Live search and browse any GitHub repo without indexing",
		})
		.command(globCommand)
		.command(readCommand)
		.command(searchCommand)
		.command(treeCommand),
	[
		"Live GitHub access without requiring indexing. Good for quick lookups.",
		"For indexed repo operations (faster, richer features), use `nia repos` instead.",
		"Code search is rate limited to 10 req/min by GitHub. Use `nia repos grep` for indexed repos.",
	],
);
