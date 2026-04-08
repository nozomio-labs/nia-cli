import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import {
	type CliSandboxSearchSseEnvelope,
	type CliSearchQueryPayload,
	createCliSdk,
	createSdk,
} from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";
import {
	renderSandboxSearchStreamEvent,
	sanitizeSandboxResultPayload,
} from "../utils/streaming.ts";

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

function splitCsvFlag(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function sanitizeSandboxFinalPayloadForTTY(
	payload: Record<string, unknown>,
	options: { verbose?: boolean } = {},
): unknown {
	const sanitizedPayload = sanitizeSandboxResultPayload(payload, {
		omitRawOutput: true,
	});
	const result =
		typeof sanitizedPayload.result === "object" &&
		sanitizedPayload.result !== null
			? (sanitizedPayload.result as Record<string, unknown>)
			: null;

	if (!result) {
		return sanitizedPayload;
	}

	if (options.verbose) {
		return sanitizedPayload;
	}

	if (typeof result.answer === "string" && result.answer.trim().length > 0) {
		return result.answer.trim();
	}

	return buildCompactSandboxTTYSummary(sanitizedPayload);
}

function buildCompactSandboxTTYSummary(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	const job =
		typeof payload.job === "object" && payload.job !== null
			? (payload.job as Record<string, unknown>)
			: null;
	const result =
		typeof payload.result === "object" && payload.result !== null
			? (payload.result as Record<string, unknown>)
			: null;

	if (job) {
		const jobSummary: Record<string, unknown> = {};
		if (typeof job.id === "string" && job.id.length > 0) {
			jobSummary.id = job.id;
		}
		if (typeof job.status === "string" && job.status.length > 0) {
			jobSummary.status = job.status;
		}
		if (Object.keys(jobSummary).length > 0) {
			summary.job = jobSummary;
		}
	}

	if (typeof result?.exitCode === "number") {
		summary.exitCode = result.exitCode;
	}

	return Object.keys(summary).length > 0 ? summary : payload;
}

export function buildExperimentalQuerySearchPayload(input: {
	query: string;
	repos?: string;
	docs?: string;
	localFolders?: string;
}): CliSearchQueryPayload {
	return {
		mode: "query",
		messages: [{ role: "user", content: input.query }],
		sources: [
			...splitCsvFlag(input.repos).map((identifier) => ({
				identifier,
				type: "repository" as const,
			})),
			...splitCsvFlag(input.docs).map((identifier) => ({
				identifier,
				type: "documentation" as const,
			})),
			...splitCsvFlag(input.localFolders).map((identifier) => ({
				identifier,
				type: "local_folder" as const,
			})),
		],
	};
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

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
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
				},
			);
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

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
					const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

					if (cliSdk.experimental) {
						const payload = buildExperimentalQuerySearchPayload({
							query: args.query,
							repos: flags.repos,
							docs: flags.docs,
							localFolders: flags["local-folders"],
						});

						if (payload.sources.length === 0) {
							fmt.error(
								"Experimental query search requires at least one of --repos, --docs, or --local-folders.",
							);
							process.exit(1);
						}

						const ignoredFlags = [
							flags["search-mode"] !== undefined ? "--search-mode" : null,
							flags.category !== undefined ? "--category" : null,
							flags["max-tokens"] !== undefined ? "--max-tokens" : null,
							flags.fast !== undefined ? "--fast" : null,
							flags["skip-llm"] !== undefined ? "--skip-llm" : null,
							flags.strategy !== undefined ? "--strategy" : null,
							flags.model !== undefined ? "--model" : null,
						].filter((flag): flag is string => flag !== null);

						if (ignoredFlags.length > 0) {
							fmt.warn(
								`Ignoring legacy-only flags in experimental mode: ${ignoredFlags.join(", ")}`,
							);
						}

						const result = await cliSdk.search.query(payload);
						fmt.output(result);
						return;
					}

					const sdk = await createSdk({ apiKey: flags["api-key"] });
					const params: Record<string, unknown> = {
						messages: [{ role: "user", content: args.query }],
					};
					const repositories = splitCsvFlag(flags.repos);
					const dataSources = splitCsvFlag(flags.docs);
					const localFolders = splitCsvFlag(flags["local-folders"]);
					if (repositories.length > 0) {
						params.repositories = repositories;
					}
					if (dataSources.length > 0) {
						params.data_sources = dataSources;
					}
					if (localFolders.length > 0) {
						params.local_folders = localFolders;
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
				},
			);
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

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
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
				},
			);
		}),
	[
		"Only use when the source is completely unknown and not indexed in Nia.",
		"Always check indexed sources first with `nia search query` or `nia search universal`.",
		"Use `--category` to narrow results (e.g., `github`, `research`, `news`).",
	],
);

const sandboxJobCommand = annotate(
	app
		.sub("job")
		.meta({
			description: "Fetch a sandbox search job by id",
		})
		.args([
			{
				name: "jobId",
				type: "string",
				description: "Job id (UUID) from a previous `nia search sandbox` run",
				required: true,
			},
		] as const)
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
					const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
					const result = await cliSdk.sandbox.getJob(args.jobId);
					fmt.output(result);
				},
			);
		}),
	["Re-fetch job status and result without starting a new sandbox run."],
);

const sandboxSearchCommand = annotate(
	app
		.sub("sandbox")
		.meta({
			description: "Agentic search in an ephemeral sandbox clone",
		})
		.command(sandboxJobCommand)
		.args([
			{
				name: "query",
				type: "string",
				description: "Natural-language task or question about the repository",
				required: true,
			},
		] as const)
		.flags({
			repository: {
				type: "string",
				short: "r",
				description:
					"Full HTTPS URL of the git repository (e.g. https://github.com/org/repo). Short owner/repo paths are not accepted.",
				required: true,
			},
			ref: {
				type: "string",
				description: "Optional git ref (branch, tag, or commit) to check out",
			},
			stream: {
				type: "boolean",
				description:
					"Stream sandbox progress updates (use --no-stream to disable)",
				default: true,
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
					const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

					const body = {
						repository: flags.repository,
						query: args.query,
						...(flags.ref ? { ref: flags.ref } : {}),
					};

					if (flags.stream === false) {
						const result = await cliSdk.sandbox.search(body);
						if (typeof result === "object" && result !== null) {
							if (process.stdout.isTTY && fmt.format === "text") {
								fmt.output(
									sanitizeSandboxFinalPayloadForTTY(
										result as Record<string, unknown>,
										{ verbose: Boolean(flags.verbose) },
									),
								);
								return;
							}

							if (!process.stdout.isTTY && !flags.verbose) {
								fmt.output(
									sanitizeSandboxResultPayload(
										result as Record<string, unknown>,
										{ omitRawOutput: true },
									),
								);
								return;
							}
						}

						fmt.output(result);
						return;
					}

					let finalPayload: Record<string, unknown> | null = null;
					let streamError: Extract<
						CliSandboxSearchSseEnvelope,
						{ type: "error" }
					> | null = null;
					let renderedSandboxText = false;
					let renderedSandboxActivity = false;

					for await (const event of cliSdk.sandbox.streamSearch(body)) {
						const renderResult = renderSandboxSearchStreamEvent(event, {
							color: flags.color,
							verbose: Boolean(flags.verbose),
						});
						renderedSandboxText ||= renderResult.renderedText;
						renderedSandboxActivity ||= renderResult.renderedActivity;

						if (event.type === "result") {
							finalPayload = event.payload;
						}
						if (event.type === "error") {
							streamError = event;
						}
					}

					if (streamError && !finalPayload) {
						throw new Error(streamError.message);
					}

					if (finalPayload && process.stdout.isTTY && fmt.format === "text") {
						if (!flags.verbose && renderedSandboxText) {
							return;
						}

						const ttyPayload = sanitizeSandboxFinalPayloadForTTY(finalPayload, {
							verbose: Boolean(flags.verbose),
						});
						if (renderedSandboxActivity) {
							console.log();
						}
						fmt.output(ttyPayload);
						return;
					}

					if (finalPayload && process.stdout.isTTY) {
						fmt.output(finalPayload);
					}
				},
			);
		}),
	[
		"Runs in a remote sandbox with a fresh clone (or cache), not indexed Nia sources.",
		"Prefer `nia search query` when the repo is already indexed; use sandbox for ad-hoc exploration or repos you have not added.",
		"Expect longer latency than indexed search; usage may be billed as a query on the server.",
		"Subcommand `nia search sandbox job <jobId>` re-fetches an earlier job.",
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

			await withErrorHandling(
				{ domain: "Search", verbose: Boolean(flags.verbose) },
				async () => {
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
				},
			);
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
		.command(sandboxSearchCommand)
		.command(deepCommand),
	[
		"Always check indexed sources before falling back to web search.",
		"Prefer `query` for targeted search with specific repos/docs, `universal` for broad search across all indexed sources.",
		"Only use `web` when the source is completely unknown and not indexed.",
		"Use `sandbox` for agentic search in an ephemeral repo clone when indexing is unnecessary or unavailable.",
		"Use `deep` for complex multi-step research (Pro plan required).",
	],
);
