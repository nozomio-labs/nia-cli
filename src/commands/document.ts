import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";
import { readEventStream, renderStreamEvent } from "../utils/streaming.ts";

// --- Types ---

interface Citation {
	content: string;
	page_number: number;
	section_title: string;
	tool_source: string;
}

interface DocumentAgentResponse {
	answer: string;
	citations: Citation[];
	structured_output: Record<string, unknown> | null;
	model: string;
	usage: { input_tokens: number; output_tokens: number };
}

// --- Subcommands ---

const agentCommand = annotate(
	app
		.sub("agent")
		.meta({
			description:
				"Run an AI agent that searches, reads, and analyzes a document to answer your question",
		})
		.args([
			{
				name: "source-id",
				type: "string",
				description: "Source ID of the indexed document",
				required: true,
			},
			{
				name: "question",
				type: "string",
				description: "Question to investigate",
				required: true,
			},
		] as const)
		.flags({
			model: {
				type: "string",
				description: "Model to use (default: claude-opus-4-6-1m)",
			},
			schema: {
				type: "string",
				description: "JSON schema string for structured output",
			},
			stream: {
				type: "boolean",
				description: "Stream the response via SSE",
				default: false,
			},
			thinking: {
				type: "boolean",
				description: "Enable thinking/reasoning (use --no-thinking to disable)",
				default: true,
			},
			"thinking-budget": {
				type: "number",
				description: "Token budget for thinking (default: 10000)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Document" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });
				const baseUrl = await resolveBaseUrl();
				const token = OpenAPI.TOKEN;

				const body: Record<string, unknown> = {
					source_id: args["source-id"],
					query: args.question,
					model: flags.model ?? "claude-opus-4-6-1m",
					thinking_enabled: flags.thinking,
					thinking_budget: flags["thinking-budget"] ?? 10000,
					stream: flags.stream ?? false,
				};

				if (flags.schema) {
					try {
						body.json_schema = JSON.parse(flags.schema);
					} catch {
						fmt.error(
							"Invalid JSON schema. Provide a valid JSON string with --schema.",
						);
						process.exit(1);
					}
				}

				if (flags.stream) {
					// Streaming mode: SSE parsing similar to oracle chat
					const response = await fetch(`${baseUrl}/document/agent`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});

					if (!response.ok || !response.body) {
						const err = new Error(
							`Document agent request failed with status ${response.status}`,
						);
						(err as Error & { status: number }).status = response.status;
						throw err;
					}

					await readEventStream(response.body, (event) => {
						renderStreamEvent(event, { color: flags.color });
					});

					if (process.stdout.isTTY) {
						console.log();
					}
				} else {
					// Non-streaming mode: single POST request
					const response = await fetch(`${baseUrl}/document/agent`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});

					if (!response.ok) {
						const err = new Error(
							`Document agent request failed with status ${response.status}`,
						);
						(err as Error & { status: number }).status = response.status;
						throw err;
					}

					const result = (await response.json()) as DocumentAgentResponse;

					// Display the answer
					console.log(result.answer);

					// Display structured output if present
					if (result.structured_output) {
						console.log("\n--- Structured Output ---");
						fmt.output(result.structured_output);
					}

					// Display citations
					if (result.citations && result.citations.length > 0) {
						console.log("\n--- Citations ---");
						for (const [i, citation] of result.citations.entries()) {
							console.log(
								`\n[${i + 1}] ${citation.section_title || "Untitled section"}`,
							);
							if (citation.page_number) {
								console.log(`    Page: ${citation.page_number}`);
							}
							if (citation.tool_source) {
								console.log(`    Source: ${citation.tool_source}`);
							}
							if (citation.content) {
								console.log(`    ${citation.content}`);
							}
						}
					}

					// Display usage
					if (result.usage) {
						console.log(
							`\nModel: ${result.model} | Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`,
						);
					}
				}
			});
		}),
	[
		"Multi-step AI agent that autonomously searches, reads pages, and analyzes document sections to answer your question.",
		"Not a simple lookup — the agent uses tools (search, read sections, read pages) to research the document before responding.",
		"Pass --stream to watch the agent's progress in real-time.",
		"Use --schema to request structured JSON output conforming to a schema.",
	],
);

export const documentCommand = annotate(
	app
		.sub("document")
		.meta({
			description:
				"AI document agent — multi-step research over indexed PDFs and documents",
		})
		.command(agentCommand),
	[
		"Autonomous AI agent that researches indexed documents with tool use (search, read, analyze).",
		"Use `nia document agent <source-id> <question>` to run the agent against any indexed document.",
		"Returns answers with page-level citations.",
	],
);
