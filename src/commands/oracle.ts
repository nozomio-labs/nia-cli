import { input } from "@crustjs/prompts";
import { annotate } from "@crustjs/skills";
import type { OracleSessionChatRequest } from "nia-ai-ts";
import { DefaultService, OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import {
	normalizeUsageSummary,
	printCliUsage,
} from "../services/compat/usage.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";
import { renderStream, renderStreamEvent } from "../utils/streaming.ts";

// --- Subcommands ---

const jobCommand = annotate(
	app
		.sub("job")
		.meta({ description: "Create a new Oracle research job" })
		.args([
			{
				name: "query",
				type: "string",
				description:
					"Research question (prompted interactively if omitted in a TTY)",
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
			"output-format": {
				type: "string",
				description: "Optional structure hint for the output",
			},
			model: {
				type: "string",
				description:
					"Model to use (e.g., claude-opus-4-6, claude-sonnet-4-5-20250929)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({
				color: flags.color,
				json: flags.json,
				output: flags.output,
			});

			// Interactive mode: prompt for missing required arg and optional fields
			const query = await input({
				message: "Research question to investigate:",
				initial: args.query,
				validate: (v) => v.trim().length > 0 || "Query is required",
			});

			const repos =
				flags.repos ||
				(await input({
					message: "Repositories to search (comma-separated, optional):",
				})) ||
				undefined;

			const outputFormat =
				flags["output-format"] ||
				(await input({
					message: "Output format hint (optional):",
				})) ||
				undefined;

			await withErrorHandling({ domain: "Oracle" }, async () => {
				const sdk = await createSdk({ apiKey: flags["api-key"] });

				const payload: Record<string, unknown> = {
					query,
				};

				if (repos) {
					payload.repositories = repos.split(",").map((s) => s.trim());
				}
				if (flags.docs) {
					payload.data_sources = flags.docs.split(",").map((s) => s.trim());
				}
				if (outputFormat) {
					payload.output_format = outputFormat;
				}
				if (flags.model) {
					payload.model = flags.model;
				}

				const result = await sdk.oracle.createJob(payload);

				fmt.output(result);

				// The streaming hint is for the human text view; skip it for
				// machine formats so the payload stays a single clean document.
				const jobId = (result as Record<string, unknown>)?.job_id;
				if (jobId && fmt.format === "text") {
					console.log(`\nUse \`nia oracle stream ${jobId}\` to watch progress`);
				}
			});
		}),
	[
		"Recommended async approach for Oracle research. Creates a job and returns immediately.",
		"Use `nia oracle stream <job-id>` to watch real-time progress after creating a job.",
		"Scope the research by passing `--repos` and/or `--docs` for more focused results.",
	],
);

const statusCommand = app
	.sub("status")
	.meta({ description: "Get the status and details of an Oracle research job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Oracle job ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Oracle" }, async () => {
			const sdk = await createSdk({ apiKey: flags["api-key"] });

			const result = await sdk.oracle.getJob(args["job-id"]);

			// In text mode, show a formatted summary
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

const cancelCommand = app
	.sub("cancel")
	.meta({ description: "Cancel a running or queued Oracle research job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Oracle job ID to cancel",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			await DefaultService.cancelOracleJobV2OracleJobsJobIdDelete(
				args["job-id"],
			);

			console.log(`Job ${args["job-id"]} has been cancelled.`);
		});
	});

const jobsCommand = app
	.sub("jobs")
	.meta({ description: "List Oracle research jobs" })
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
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

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

		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result = await DefaultService.listOracleJobsV2OracleJobsGet(
				flags.status ?? undefined,
				flags.limit ?? undefined,
				flags.skip ?? undefined,
			);

			// In text/table mode, format as a table
			if (Array.isArray(result)) {
				if (result.length === 0) {
					console.log("No Oracle jobs found.");
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

// --- Streaming & Session Subcommands ---

const streamCommand = app
	.sub("stream")
	.meta({ description: "Stream real-time updates from an Oracle research job" })
	.args([
		{
			name: "job-id",
			type: "string",
			description: "Oracle job ID to stream",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Oracle" }, async () => {
			const sdk = await createSdk({ apiKey: flags["api-key"] });

			const stream = sdk.oracle.streamJob(args["job-id"]);

			await renderStream(stream, { color: flags.color });

			// Print newline after stream completes for clean terminal state
			if (process.stdout.isTTY) {
				console.log();
			}
		});
	});

const sessionsCommand = app
	.sub("sessions")
	.meta({ description: "List Oracle research sessions" })
	.flags({
		limit: {
			type: "number",
			description: "Maximum number of sessions to return",
		},
		skip: {
			type: "number",
			description: "Number of sessions to skip (for pagination)",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result = await DefaultService.listOracleSessionsV2OracleSessionsGet(
				flags.limit ?? undefined,
				flags.skip ?? undefined,
			);

			if (Array.isArray(result)) {
				if (result.length === 0) {
					console.log("No Oracle sessions found.");
				} else {
					const rows = result.map((session: Record<string, unknown>) => ({
						session_id: String(session.session_id ?? ""),
						query:
							String(session.query ?? "").length > 60
								? `${String(session.query ?? "").slice(0, 57)}...`
								: String(session.query ?? ""),
						status: String(session.status ?? ""),
						created_at: String(session.created_at ?? ""),
					}));
					fmt.output(rows);
				}
			} else {
				fmt.output(result);
			}
		});
	});

const sessionCommand = app
	.sub("session")
	.meta({ description: "Get full details of an Oracle research session" })
	.args([
		{
			name: "session-id",
			type: "string",
			description: "Oracle session ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await DefaultService.getOracleSessionDetailV2OracleSessionsSessionIdGet(
					args["session-id"],
				);

			const session = result as Record<string, unknown>;
			console.log(`Session ID: ${session.session_id ?? args["session-id"]}`);
			if (session.query) {
				console.log(`Query:      ${session.query}`);
			}
			if (session.status) {
				console.log(`Status:     ${session.status}`);
			}
			if (session.model) {
				console.log(`Model:      ${session.model}`);
			}
			if (session.created_at) {
				console.log(`Created:    ${session.created_at}`);
			}
			if (session.completed_at) {
				console.log(`Completed:  ${session.completed_at}`);
			}
			if (session.result) {
				console.log("\n--- Result ---");
				fmt.output(session.result);
			}
			if (session.job_id) {
				console.log(`\nJob ID: ${session.job_id}`);
			}
		});
	});

const messagesCommand = app
	.sub("messages")
	.meta({ description: "Get chat messages for an Oracle research session" })
	.args([
		{
			name: "session-id",
			type: "string",
			description: "Oracle session ID",
			required: true,
		},
	] as const)
	.flags({
		limit: {
			type: "number",
			description: "Maximum number of messages to return",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await DefaultService.getOracleSessionMessagesV2OracleSessionsSessionIdMessagesGet(
					args["session-id"],
					flags.limit ?? undefined,
				);

			if (Array.isArray(result)) {
				if (result.length === 0) {
					console.log("No messages found for this session.");
				} else {
					for (const msg of result) {
						const message = msg as Record<string, unknown>;
						const role = String(message.role ?? "unknown");
						const content = String(message.content ?? "");
						const timestamp = message.created_at
							? ` (${String(message.created_at)})`
							: "";

						console.log(`[${role}]${timestamp}`);
						console.log(content);
						console.log();
					}
				}
			} else {
				fmt.output(result);
			}
		});
	});

const chatCommand = annotate(
	app
		.sub("chat")
		.meta({
			description: "Send a follow-up message to an Oracle research session",
		})
		.args([
			{
				name: "session-id",
				type: "string",
				description: "Oracle session ID",
				required: true,
			},
			{
				name: "message",
				type: "string",
				description: "Follow-up question or message",
				required: true,
			},
		] as const)
		.run(async ({ args, flags }) => {
			await withErrorHandling({ domain: "Oracle" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				// The DefaultService chat endpoint returns a CancelablePromise,
				// but the actual response is an SSE stream. Use manual fetch
				// with SSE parsing similar to sdk.oracle.streamJob().
				const baseUrl = await resolveBaseUrl();
				const token = OpenAPI.TOKEN;

				const response = await fetch(
					`${baseUrl}/oracle/sessions/${encodeURIComponent(args["session-id"])}/chat/stream`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							message: args.message,
						} satisfies OracleSessionChatRequest),
					},
				);

				if (!response.ok || !response.body) {
					const err = new Error(
						`Chat request failed with status ${response.status}`,
					);
					(err as Error & { status: number }).status = response.status;
					throw err;
				}

				const reader = response.body.getReader();
				const decoder = new TextDecoder();

				// Parse SSE stream manually
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const payload = line.slice(6).trim();
						if (!payload) continue;

						try {
							const event = JSON.parse(payload) as Record<string, unknown>;
							renderStreamEvent(event, { color: flags.color });
						} catch {}
					}
				}

				// Print newline after stream completes for clean terminal state
				if (process.stdout.isTTY) {
					console.log();
				}
			});
		}),
	[
		"Send follow-up questions to an existing Oracle research session.",
		"Get the session ID from a completed job via `nia oracle status <job-id>`.",
	],
);

const deleteSessionCommand = app
	.sub("delete-session")
	.meta({
		description: "Delete an Oracle research session and its chat history",
	})
	.args([
		{
			name: "session-id",
			type: "string",
			description: "Oracle session ID to delete",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			await DefaultService.deleteOracleSessionV2OracleSessionsSessionIdDelete(
				args["session-id"],
			);

			console.log(
				`Session ${args["session-id"]} and its chat history have been deleted.`,
			);
		});
	});

const oracleUsageCommand = app
	.sub("1m-usage")
	.meta({
		description:
			"Show account Balance (remaining/limit per operation), including Oracle / 1M context",
	})
	.run(async ({ flags }) => {
		await withErrorHandling({ domain: "Oracle" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			// Use the general usage endpoint — it includes Oracle operation counts
			const { V2ApiService } = await import("nia-ai-ts");
			const result = await V2ApiService.getUsageSummaryV2V2UsageGet();
			printCliUsage(normalizeUsageSummary(result));
		});
	});

export const oracleCommand = annotate(
	app
		.sub("oracle")
		.meta({ description: "Run autonomous AI research jobs" })
		.command(jobCommand)
		.command(statusCommand)
		.command(cancelCommand)
		.command(jobsCommand)
		.command(streamCommand)
		.command(sessionsCommand)
		.command(sessionCommand)
		.command(messagesCommand)
		.command(chatCommand)
		.command(deleteSessionCommand)
		.command(oracleUsageCommand),
	[
		"Pro feature. Autonomous AI research that investigates questions across indexed sources.",
		"Use `chat` to ask follow-up questions on completed research sessions.",
	],
);
