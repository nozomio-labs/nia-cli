import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Valid extraction types for status and list commands.
 */
const EXTRACTION_TYPES = ["table", "detect", "engineering"] as const;
type ExtractionType = (typeof EXTRACTION_TYPES)[number];

/**
 * Valid accuracy modes for engineering extraction.
 */
const ACCURACY_MODES = ["fast", "precise"] as const;

/**
 * Determine whether a source string looks like a URL or a source_id.
 */
function parseSource(source: string): { url?: string; source_id?: string } {
	try {
		new URL(source);
		return { url: source };
	} catch {
		return { source_id: source };
	}
}

/**
 * Make an authenticated API request to the extraction endpoints.
 */
async function extractFetch(
	path: string,
	options: { method: string; body?: unknown },
): Promise<unknown> {
	const baseUrl = await resolveBaseUrl();
	const token = OpenAPI.TOKEN;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};

	const response = await fetch(`${baseUrl}${path}`, {
		method: options.method,
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!response.ok) {
		const err = new Error(`Request failed with status ${response.status}`);
		(err as Error & { status: number }).status = response.status;
		throw err;
	}

	return response.json();
}

/**
 * Resolve the GET endpoint path for an extraction by type.
 */
function statusPath(id: string, type: ExtractionType): string {
	switch (type) {
		case "table":
			return `/extract/${encodeURIComponent(id)}`;
		case "detect":
			return `/extract/detect/${encodeURIComponent(id)}`;
		case "engineering":
			return `/extract/engineering/${encodeURIComponent(id)}`;
	}
}

// --- Subcommands ---

const tableCommand = annotate(
	app
		.sub("table")
		.meta({ description: "Start a table extraction from a document" })
		.args([
			{
				name: "source",
				type: "string",
				description: "Document URL or source_id",
				required: true,
			},
		] as const)
		.flags({
			schema: {
				type: "string",
				description: "JSON schema defining the table structure (required)",
			},
			"page-range": {
				type: "string",
				description: "Page range to extract from (e.g., '1-5')",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			if (!flags.schema) {
				fmt.error(
					"--schema is required. Provide a JSON string defining the table structure.",
				);
				process.exit(1);
			}

			let jsonSchema: unknown;
			try {
				jsonSchema = JSON.parse(flags.schema);
			} catch {
				fmt.error(
					"--schema must be valid JSON. Check your input and try again.",
				);
				process.exit(1);
			}

			await withErrorHandling({ domain: "Extract" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: Record<string, unknown> = {
					...parseSource(args.source),
					json_schema: jsonSchema,
				};

				if (flags["page-range"]) {
					payload.page_range = flags["page-range"];
				}

				const result = await extractFetch("/extract", {
					method: "POST",
					body: payload,
				});

				fmt.output(result);

				const extraction = result as Record<string, unknown>;
				if (extraction.id) {
					console.log(
						`\nUse \`nia extract status ${extraction.id} --type table\` to check progress`,
					);
				}
			});
		}),
	[
		"--schema is required and must be a valid JSON string defining the expected table structure.",
		"Source can be a URL to a document or an existing source_id.",
		"Use --page-range to limit extraction to specific pages (e.g., '1-5').",
	],
);

const detectCommand = annotate(
	app
		.sub("detect")
		.meta({
			description: "Start detection extraction to find elements in a document",
		})
		.args([
			{
				name: "source",
				type: "string",
				description: "Document URL or source_id",
				required: true,
			},
		] as const)
		.flags({
			"page-range": {
				type: "string",
				description: "Page range to process (e.g., '1-5')",
			},
			symbols: {
				type: "boolean",
				description: "Include symbol detection",
			},
			filter: {
				type: "string",
				description: "Filter pattern for detection results",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Extract" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: Record<string, unknown> = {
					...parseSource(args.source),
				};

				if (flags["page-range"]) {
					payload.page_range = flags["page-range"];
				}
				if (flags.symbols !== undefined) {
					payload.include_symbols = flags.symbols;
				}
				if (flags.filter) {
					payload.filter_pattern = flags.filter;
				}

				const result = await extractFetch("/extract/detect", {
					method: "POST",
					body: payload,
				});

				fmt.output(result);

				const extraction = result as Record<string, unknown>;
				if (extraction.id) {
					console.log(
						`\nUse \`nia extract status ${extraction.id} --type detect\` to check progress`,
					);
				}
			});
		}),
	[
		"Detects elements like tables, figures, and text blocks in documents.",
		"Use --symbols to include symbol detection in results.",
		"Use --filter to apply a regex pattern to filter detection results.",
	],
);

const engineeringCommand = annotate(
	app
		.sub("engineering")
		.meta({
			description:
				"Start engineering extraction for technical document analysis",
		})
		.args([
			{
				name: "source",
				type: "string",
				description: "Document URL or source_id",
				required: true,
			},
		] as const)
		.flags({
			"page-range": {
				type: "string",
				description: "Page range to process (e.g., '1-5')",
			},
			accuracy: {
				type: "string",
				description: "Accuracy mode: fast or precise (default: fast)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			if (
				flags.accuracy &&
				!ACCURACY_MODES.includes(
					flags.accuracy as (typeof ACCURACY_MODES)[number],
				)
			) {
				fmt.error(
					`Invalid accuracy mode: "${flags.accuracy}". Allowed: ${ACCURACY_MODES.join(", ")}`,
				);
				process.exit(1);
			}

			await withErrorHandling({ domain: "Extract" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: Record<string, unknown> = {
					...parseSource(args.source),
				};

				if (flags["page-range"]) {
					payload.page_range = flags["page-range"];
				}
				if (flags.accuracy) {
					payload.accuracy_mode = flags.accuracy;
				}

				const result = await extractFetch("/extract/engineering", {
					method: "POST",
					body: payload,
				});

				fmt.output(result);

				const extraction = result as Record<string, unknown>;
				if (extraction.id) {
					console.log(
						`\nUse \`nia extract status ${extraction.id} --type engineering\` to check progress`,
					);
					console.log(
						`Use \`nia extract query ${extraction.id} "your question"\` to query results conversationally`,
					);
				}
			});
		}),
	[
		"Extracts structured data from engineering and technical documents.",
		"Use --accuracy precise for higher quality results at the cost of speed.",
		"After extraction completes, use `nia extract query` to ask questions about the results.",
	],
);

const extractStatusCommand = app
	.sub("status")
	.meta({ description: "Get the status and results of an extraction" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Extraction ID",
			required: true,
		},
	] as const)
	.flags({
		type: {
			type: "string",
			description:
				"Extraction type: table, detect, or engineering (default: table)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		const type = (flags.type ?? "table") as ExtractionType;
		if (!EXTRACTION_TYPES.includes(type)) {
			fmt.error(
				`Invalid extraction type: "${flags.type}". Allowed: ${EXTRACTION_TYPES.join(", ")}`,
			);
			process.exit(1);
		}

		await withErrorHandling({ domain: "Extract" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result = await extractFetch(statusPath(args.id, type), {
				method: "GET",
			});

			fmt.output(result);

			const extraction = result as Record<string, unknown>;
			if (
				extraction.status === "processing" ||
				extraction.status === "queued"
			) {
				console.log(
					"\nExtraction is still processing. Check again later with:",
				);
				console.log(`  nia extract status ${args.id} --type ${type}`);
			}
		});
	});

const queryCommand = annotate(
	app
		.sub("query")
		.meta({
			description: "Query an engineering extraction conversationally",
		})
		.args([
			{
				name: "id",
				type: "string",
				description: "Engineering extraction ID",
				required: true,
			},
			{
				name: "question",
				type: "string",
				description: "Question to ask about the extracted data",
				required: true,
			},
		] as const)
		.run(async ({ args, flags }) => {
			await withErrorHandling({ domain: "Extract" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });
				const baseUrl = await resolveBaseUrl();
				const token = OpenAPI.TOKEN;

				const response = await fetch(
					`${baseUrl}/extract/engineering/${encodeURIComponent(args.id)}/query`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ query: args.question }),
					},
				);

				if (!response.ok || !response.body) {
					const err = new Error(`Request failed with status ${response.status}`);
					(err as Error & { status: number }).status = response.status;
					throw err;
				}

				// SSE stream — parse and render answer chunks
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
							const event = JSON.parse(payload) as Record<string, unknown>;
							if (event.type === "answer_chunk" && typeof event.content === "string") {
								process.stdout.write(event.content);
							}
						} catch {}
					}
				}

				if (process.stdout.isTTY) {
					console.log();
				}
			});
		}),
	[
		"Requires a completed engineering extraction.",
		"Ask natural language questions about the extracted data.",
		"Conversation history is managed server-side per extraction.",
	],
);

const listCommand = app
	.sub("list")
	.meta({ description: "List extractions" })
	.flags({
		type: {
			type: "string",
			description: "Filter by type: table or engineering",
		},
		limit: {
			type: "number",
			description: "Maximum number of results (default: 30)",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		if (
			flags.type &&
			flags.type !== "table" &&
			flags.type !== "engineering"
		) {
			fmt.error(
				`Invalid extraction type: "${flags.type}". Allowed for listing: table, engineering`,
			);
			process.exit(1);
		}

		await withErrorHandling({ domain: "Extract" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const params = new URLSearchParams();
			if (flags.type) {
				params.set("type", flags.type);
			}
			if (flags.limit !== undefined) {
				params.set("limit", String(flags.limit));
			}

			const queryString = params.toString();
			const path = `/extractions${queryString ? `?${queryString}` : ""}`;

			const result = await extractFetch(path, { method: "GET" });

			fmt.output(result);
		});
	});

// --- Parent command ---

export const extractCommand = annotate(
	app
		.sub("extract")
		.meta({
			description: "Extract structured data from documents",
		})
		.command(tableCommand)
		.command(detectCommand)
		.command(engineeringCommand)
		.command(extractStatusCommand)
		.command(queryCommand)
		.command(listCommand),
	[
		"Extract structured data from documents using table, detection, or engineering modes.",
		"Use `table` for structured table extraction with a JSON schema.",
		"Use `detect` to find elements like tables, figures, and text blocks.",
		"Use `engineering` for technical document analysis with optional conversational querying.",
		"Check extraction progress with `status` and list all extractions with `list`.",
	],
);
