import { annotate } from "@crustjs/skills";
import type { TracerRequest } from "nia-ai-ts";
import { GithubSearchService, OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

import { readEventStream, renderStreamEvent } from "../utils/streaming.ts";

// --- Subcommands ---

const runCommand = annotate(
	app
		.sub("run")
		.meta({ description: "Create a new Tracer code search job" })
		.args([
			{
				name: "query",
				type: "string",
				description: "Research question to search for in GitHub repositories",
				required: true,
			},
		] as const)
		.flags({
			repos: {
				type: "string",
				description:
					"Repositories to search in owner/repo format (comma-separated)",
			},
			context: {
				type: "string",
				description: "Additional context for the search query",
			},
			model: {
				type: "string",
				description: "Model override (claude-opus-4-6 or claude-opus-4-6-1m)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Tracer" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: TracerRequest = {
					query: args.query,
				};

				if (flags.repos) {
					payload.repositories = flags.repos.split(",").map((s) => s.trim());
				}
				if (flags.context) {
					payload.context = flags.context;
				}
				if (flags.model) {
					payload.model = flags.model;
				}

				const result =
					await GithubSearchService.createTracerJobV2GithubTracerPost(payload);

				fmt.output(result);

				// Print hint for streaming in text/table mode
				const jobId = (result as Record<string, unknown>)?.job_id;
				if (jobId) {
					console.log(`\nUse \`nia tracer stream ${jobId}\` to watch progress`);
				}
			});
		}),
	[
		"Use when exploring unfamiliar repositories you haven't indexed.",
		"Delegates to specialized sub-agents for faster, more thorough results.",
		"Use `--context` to provide additional guidance for the search.",
		"Use `nia tracer stream <job-id>` to watch real-time progress.",
	],
);

const statusCommand = app
	.sub("status")
	.meta({ description: "Get the status and result of a Tracer search job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Tracer job ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Tracer" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await GithubSearchService.getTracerJobV2GithubTracerJobIdGet(
					args["job-id"],
				);

			// Show a formatted summary
			const job = result as Record<string, unknown>;
			console.log(`Job ID:     ${job.job_id ?? args["job-id"]}`);
			console.log(`Status:     ${job.status ?? "unknown"}`);
			if (job.query) {
				console.log(`Query:      ${job.query}`);
			}
			if (job.session_id) {
				console.log(`Session ID: ${job.session_id}`);
			}
			if (job.created_at) {
				console.log(`Created:    ${job.created_at}`);
			}
			if (job.completed_at) {
				console.log(`Completed:  ${job.completed_at}`);
			}
			if (job.result) {
				console.log("\n--- Result ---");
				fmt.output(job.result);
			}
			if (job.error) {
				console.log(`\nError: ${job.error}`);
			}
		});
	});

const streamCommand = app
	.sub("stream")
	.meta({ description: "Stream real-time updates from a Tracer search job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Tracer job ID to stream",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Tracer" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			// GithubSearchService.streamTracerJobV2GithubTracerJobIdStreamGet()
			// returns CancelablePromise<any>, not an AsyncGenerator.
			// Use manual SSE fetch + reader pattern (same as oracle chat).
			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(
				`${baseUrl}/github/tracer/${encodeURIComponent(args["job-id"])}/stream`,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "text/event-stream",
					},
				},
			);

			if (!response.ok || !response.body) {
				const err = new Error(
					`Stream request failed with status ${response.status}`,
				);
				(err as Error & { status: number }).status = response.status;
				throw err;
			}

			await readEventStream(response.body, (event) => {
				renderStreamEvent(event, { color: flags.color });
			});

			// Print newline after stream completes for clean terminal state
			if (process.stdout.isTTY) {
				console.log();
			}
		});
	});

const listCommand = app
	.sub("list")
	.meta({ description: "List Tracer search jobs" })
	.flags({
		status: {
			type: "string",
			description:
				"Filter by status: queued, running, completed, failed, cancelled",
		},
		limit: {
			type: "number",
			description: "Maximum number of jobs to return",
		},
		skip: {
			type: "number",
			description: "Number of jobs to skip (for pagination)",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		// Validate status if provided
		const validStatuses = [
			"queued",
			"running",
			"completed",
			"failed",
			"cancelled",
		];
		if (flags.status && !validStatuses.includes(flags.status)) {
			fmt.error(
				`Invalid status: "${flags.status}". Allowed: ${validStatuses.join(", ")}`,
			);
			process.exit(1);
		}

		await withErrorHandling({ domain: "Tracer" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result = await GithubSearchService.listTracerJobsV2GithubTracerGet(
				flags.status ?? undefined,
				flags.limit ?? undefined,
				flags.skip ?? undefined,
			);

			// Format as a table
			if (Array.isArray(result)) {
				if (result.length === 0) {
					console.log("No Tracer jobs found.");
				} else {
					const rows = result.map((job: Record<string, unknown>) => ({
						job_id: String(job.job_id ?? ""),
						status: String(job.status ?? ""),
						query:
							String(job.query ?? "").length > 60
								? `${String(job.query ?? "").slice(0, 57)}...`
								: String(job.query ?? ""),
						created_at: String(job.created_at ?? ""),
					}));
					fmt.output(rows);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete a Tracer search job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Tracer job ID to delete",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Tracer" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			await GithubSearchService.deleteTracerJobV2GithubTracerJobIdDelete(
				args["job-id"],
			);

			console.log(`Tracer job ${args["job-id"]} has been deleted.`);
		});
	});

export const tracerCommand = annotate(
	app
		.sub("tracer")
		.meta({ description: "Autonomous GitHub code search without indexing" })
		.command(runCommand)
		.command(statusCommand)
		.command(streamCommand)
		.command(listCommand)
		.command(deleteCommand),
	[
		"Pro feature. Autonomous agent for searching GitHub repositories without indexing.",
		"Use when exploring unfamiliar repos or searching code you haven't indexed.",
		"For indexed repository operations, use `nia repos` instead.",
	],
);
