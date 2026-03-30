import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";
import { renderStreamEvent } from "../utils/streaming.ts";

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

const queryCommand = annotate(
	app
		.sub("query")
		.meta({ description: "Query a document with AI agent" })
		.args([
			{
				name: "source-id",
				type: "string",
				description: "Source ID of the document to query",
				required: true,
			},
			{
				name: "question",
				type: "string",
				description: "Question to ask about the document",
				required: true,
			},
		] as const)
		.flags({
			model: {
				type: "string",
				description:
					"Model to use (default: claude-opus-4-6-1m)",
			},
			schema: {
				type: "string",
				description:
					"JSON schema string for structured output",
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
					const response = await fetch(
						`${baseUrl}/document/agent`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify(body),
						},
					);

					if (!response.ok || !response.body) {
						const err = new Error(
							`Document agent request failed with status ${response.status}`,
						);
						(err as Error & { status: number }).status =
							response.status;
						throw err;
					}

					const reader = response.body.getReader();
					const decoder = new TextDecoder();

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
								const event = JSON.parse(payload) as Record<
									string,
									unknown
								>;
								renderStreamEvent(event, {
									color: flags.color,
								});
							} catch {}
						}
					}

					if (process.stdout.isTTY) {
						console.log();
					}
				} else {
					// Non-streaming mode: single POST request
					const response = await fetch(
						`${baseUrl}/document/agent`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify(body),
						},
					);

					if (!response.ok) {
						const err = new Error(
							`Document agent request failed with status ${response.status}`,
						);
						(err as Error & { status: number }).status =
							response.status;
						throw err;
					}

					const result =
						(await response.json()) as DocumentAgentResponse;

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
								console.log(
									`    Source: ${citation.tool_source}`,
								);
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
		"Query a document using the AI document agent.",
		"Pass --stream to receive the response as a real-time stream.",
		"Use --schema to request structured JSON output conforming to a schema.",
	],
);

export const documentCommand = annotate(
	app
		.sub("document")
		.meta({ description: "Query documents with AI agent" })
		.command(queryCommand),
	[
		"AI-powered document querying with citations.",
		"Use `nia document query <source-id> <question>` to ask questions about indexed documents.",
	],
);
