import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

export function resolveQuerySearchMode(input: {
	explicit?: string;
	repos?: string;
	docs?: string;
	localFolders?: string;
}): string {
	if (input.explicit) {
		return input.explicit;
	}

	const hasRepos = Boolean(input.repos?.trim());
	const hasSources = Boolean(input.docs?.trim() || input.localFolders?.trim());

	if (hasRepos && !hasSources) {
		return "repositories";
	}
	if (!hasRepos && hasSources) {
		return "sources";
	}
	return "unified";
}

const universalCommand = annotate(
	app
		.sub("universal")
		.meta({ description: "Semantic search across all indexed sources" })
		.args([
			{
				name: "query",
				type: "string",
				description: "Search query",
				required: true,
			},
		] as const)
		.flags({
			"top-k": {
				type: "number",
				description: "Number of results to return",
			},
			"include-repos": {
				type: "boolean",
				description: "Include repository sources",
			},
			"include-docs": {
				type: "boolean",
				description: "Include documentation sources",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Search" }, async () => {
				const sdk = await createSdk({ apiKey: flags["api-key"] });

				const params: Record<string, unknown> = {
					query: args.query,
				};

				if (flags["top-k"] !== undefined) {
					params.top_k = flags["top-k"];
				}
				if (flags["include-repos"] !== undefined) {
					params.include_repos = flags["include-repos"];
				}
				if (flags["include-docs"] !== undefined) {
					params.include_docs = flags["include-docs"];
				}

				const result = await sdk.search.universal(params);

				fmt.output(result);
			});
		}),
	[
		"Hybrid vector + BM25 search across all indexed public sources (repos, docs, HF datasets).",
		"Does NOT include Slack workspaces. Use `nia search query` for Slack-inclusive search.",
		"Good default when you want a broad search across everything indexed.",
	],
);

const queryCommand = annotate(
	app
		.sub("query")
		.meta({
			description: "Query indexed repositories, sources, and local folders",
		})
		.args([
			{
				name: "query",
				type: "string",
				description: "Search query",
				required: true,
			},
		] as const)
		.flags({
			repos: {
				type: "string",
				description: "Repository names to search (comma-separated)",
			},
			docs: {
				type: "string",
				description: "Documentation source names to search (comma-separated)",
			},
			"local-folders": {
				type: "string",
				description: "Local folder IDs or names to search (comma-separated)",
			},
			category: {
				type: "string",
				description: "Local folder category filter",
			},
			"search-mode": {
				type: "string",
				description: "Search mode: repositories, sources, unified",
			},
			"max-tokens": {
				type: "number",
				description: "Maximum tokens in response",
			},
			fast: {
				type: "boolean",
				description: "Fast mode — skip LLM processing (100-500ms)",
			},
			"skip-llm": {
				type: "boolean",
				description: "Return raw results without LLM processing",
			},
			strategy: {
				type: "string",
				description: "Retrieval strategy: vector, tree, hybrid",
			},
			model: {
				type: "string",
				description: "LLM model to use for processing",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Search" }, async () => {
				const sdk = await createSdk({ apiKey: flags["api-key"] });

				const params: Record<string, unknown> = {
					messages: [{ role: "user", content: args.query }],
				};

				if (flags.repos) {
					params.repositories = flags.repos.split(",").map((s) => s.trim());
				}
				if (flags.docs) {
					params.data_sources = flags.docs.split(",").map((s) => s.trim());
				}
				if (flags["local-folders"]) {
					params.local_folders = flags["local-folders"]
						.split(",")
						.map((s) => s.trim());
				}
				params.search_mode = resolveQuerySearchMode({
					explicit: flags["search-mode"],
					repos: flags.repos,
					docs: flags.docs,
					localFolders: flags["local-folders"],
				});
				if (flags.category) {
					params.category = flags.category;
				}
				if (flags["max-tokens"] !== undefined) {
					params.max_tokens = flags["max-tokens"];
				}
				if (flags.fast !== undefined) {
					params.fast_mode = flags.fast;
				}
				if (flags["skip-llm"] !== undefined) {
					params.skip_llm = flags["skip-llm"];
				}
				if (flags.strategy) {
					params.reasoning_strategy = flags.strategy;
				}
				if (flags.model) {
					params.model = flags.model;
				}

				const result = await sdk.search.query(params);

				fmt.output(result);
			});
		}),
	[
		"Targeted search with AI response and sources. Pass repos, docs, and local folders as comma-separated strings.",
		"Use `repositories` mode for repo-only search, `sources` mode for docs/local-folders-only search, and `unified` when multiple source types are involved.",
		"Search mode is auto-detected: `repositories` when only `--repos`, `sources` when only `--docs` or `--local-folders`, `unified` when mixed. Override with `--search-mode` only when needed.",
		"Use `--skip-llm` to return raw search results without AI synthesis.",
	],
);

const WEB_SEARCH_CATEGORIES = [
	"github",
	"company",
	"research",
	"news",
	"tweet",
	"pdf",
	"blog",
] as const;

const webCommand = annotate(
	app
		.sub("web")
		.meta({
			description: "Search the web for code, documentation, and research",
		})
		.args([
			{
				name: "query",
				type: "string",
				description: "Search query",
				required: true,
			},
		] as const)
		.flags({
			"num-results": {
				type: "number",
				description: "Number of results to return",
			},
			category: {
				type: "string",
				description:
					"Category filter: github, company, research, news, tweet, pdf, blog",
			},
			"days-back": {
				type: "number",
				description: "Only results from the last N days",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			// Validate category if provided
			if (
				flags.category &&
				!WEB_SEARCH_CATEGORIES.includes(
					flags.category as (typeof WEB_SEARCH_CATEGORIES)[number],
				)
			) {
				fmt.error(
					`Invalid category: "${flags.category}". Allowed: ${WEB_SEARCH_CATEGORIES.join(", ")}`,
				);
				process.exit(1);
			}

			await withErrorHandling({ domain: "Search" }, async () => {
				const sdk = await createSdk({ apiKey: flags["api-key"] });

				const params: Record<string, unknown> = {
					query: args.query,
				};

				if (flags["num-results"] !== undefined) {
					params.num_results = flags["num-results"];
				}
				if (flags.category) {
					params.category = flags.category;
				}
				if (flags["days-back"] !== undefined) {
					params.days_back = flags["days-back"];
				}

				const result = await sdk.search.web(params);

				fmt.output(result);
			});
		}),
	[
		"Only use when the source is completely unknown and not indexed in Nia.",
		"Always check indexed sources first with `nia search query` or `nia search universal`.",
		"Use `--category` to narrow results (e.g., `github`, `research`, `news`).",
	],
);

const deepCommand = annotate(
	app
		.sub("deep")
		.meta({ description: "Deep multi-step research (Pro plan required)" })
		.args([
			{
				name: "query",
				type: "string",
				description: "Research question",
				required: true,
			},
		] as const)
		.flags({
			"output-format": {
				type: "string",
				description: "Optional structure hint for the output",
			},
			model: {
				type: "string",
				description: "LLM model to use for research",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Search" }, async () => {
				const sdk = await createSdk({ apiKey: flags["api-key"] });

				const params: Record<string, unknown> = {
					query: args.query,
				};

				if (flags["output-format"]) {
					params.output_format = flags["output-format"];
				}
				if (flags.model) {
					params.model = flags.model;
				}
				if (flags.verbose) {
					params.verbose = true;
				}

				const result = await sdk.search.deep(params);

				fmt.output(result);
			});
		}),
	[
		"Requires Pro plan. Use for complex research questions needing multi-step investigation.",
		"Only use when simpler search commands (`query`, `universal`) are insufficient.",
		"Use `--verbose` to see intermediate research steps.",
	],
);

export const searchCommand = annotate(
	app
		.sub("search")
		.meta({ description: "Search code, docs, and the web" })
		.command(universalCommand)
		.command(queryCommand)
		.command(webCommand)
		.command(deepCommand),
	[
		"Always check indexed sources before falling back to web search.",
		"Prefer `query` for targeted search with specific repos/docs, `universal` for broad search across all indexed sources.",
		"Only use `web` when the source is completely unknown and not indexed.",
		"Use `deep` for complex multi-step research (Pro plan required).",
	],
);
