import { annotate } from "@crustjs/skills";
import type { HuggingFaceDatasetRequest } from "nia-ai-ts";
import { V2ApiDataSourcesService } from "nia-ai-ts";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Subcommands ---

const indexCommand = annotate(
	app
		.sub("index")
		.meta({ description: "Index a HuggingFace dataset" })
		.args([
			{
				name: "dataset",
				type: "string",
				description:
					"HuggingFace dataset URL or identifier (e.g., dair-ai/emotion, https://huggingface.co/datasets/squad)",
				required: true,
			},
		] as const)
		.flags({
			config: {
				type: "string",
				description: "Dataset configuration name (for multi-config datasets)",
			},
			global: {
				type: "boolean",
				description: "Add to global shared pool (default: true)",
				default: true,
			},
		})
		.run(async ({ args, flags }) => {
			await withErrorHandling({ domain: "Dataset" }, async () => {
				await createSdk({ apiKey: flags["api-key"] });

				const payload: HuggingFaceDatasetRequest = {
					url: args.dataset,
				};

				if (flags.config) {
					payload.config = flags.config;
				}

				if (flags.global === false) {
					payload.add_as_global_source = false;
				}

				const result =
					await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
						payload,
					);

				const data = result as Record<string, unknown>;
				console.log("Dataset indexed successfully.");
				if (data.source_id) {
					console.log(`  Source ID: ${data.source_id}`);
				}
				if (data.name) {
					console.log(`  Name: ${data.name}`);
				}
				if (data.status) {
					console.log(`  Status: ${data.status}`);
				}
				if (data.message) {
					console.log(`  ${data.message}`);
				}
			});
		}),
	[
		"Supports dataset IDs (`squad`), org/name (`dair-ai/emotion`), and full HuggingFace URLs.",
		"Use `--config` for multi-config datasets to select a specific configuration.",
	],
);

const listCommand = app
	.sub("list")
	.meta({ description: "List indexed HuggingFace datasets" })
	.flags({
		status: {
			type: "string",
			description: "Filter by status: processing, completed, failed",
		},
		limit: {
			type: "number",
			description: "Maximum number of results",
		},
		offset: {
			type: "number",
			description: "Pagination offset",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Dataset" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result =
				await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet(
					flags.status ?? undefined,
					flags.limit ?? undefined,
					flags.offset ?? undefined,
				);

			const data = result as Record<string, unknown>;
			const datasets = (data.datasets ?? data.items ?? []) as Array<
				Record<string, unknown>
			>;

			if (datasets.length === 0) {
				console.log("No HuggingFace datasets found.");
			} else {
				const rows = datasets.map((d) => ({
					name: d.display_name ?? d.name ?? d.title ?? "Untitled",
					id: d.source_id ?? d.id ?? "",
					status: d.status ?? "",
					created: d.created_at ?? "",
				}));
				console.log(fmt.formatTable(rows, ["name", "id", "status", "created"]));

				if (data.total !== undefined) {
					console.log(`\nTotal: ${data.total} datasets`);
				}
			}
		});
	});

export const datasetsCommand = annotate(
	app
		.sub("datasets")
		.meta({ description: "Index and list HuggingFace datasets" })
		.command(indexCommand)
		.command(listCommand),
	[
		"Index HuggingFace datasets for searchable access via Nia.",
		"After indexing, search dataset content with `nia search query` or `nia search universal`.",
	],
);
