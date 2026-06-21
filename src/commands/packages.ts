import { annotate } from "@crustjs/skills";
import type {
	PackageSearchGrepRequest,
	PackageSearchHybridRequest,
	PackageSearchReadFileRequest,
} from "nia-ai-ts";
import { V2ApiPackageSearchService } from "nia-ai-ts";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Valid package registries supported by the API.
 */
const VALID_REGISTRIES = [
	"npm",
	"py_pi",
	"crates_io",
	"golang_proxy",
	"ruby_gems",
];

/**
 * Validate registry argument against allowed values.
 */
function validateRegistry(registry: string): void {
	if (!VALID_REGISTRIES.includes(registry)) {
		console.error(
			`Invalid registry: "${registry}". Allowed: ${VALID_REGISTRIES.join(", ")}`,
		);
		process.exit(1);
	}
}

// --- Subcommands ---

const grepCommand = app
	.sub("grep")
	.meta({ description: "Regex search over public package source code" })
	.args([
		{
			name: "registry",
			type: "string",
			description:
				"Package registry: npm, py_pi, crates_io, golang_proxy, ruby_gems",
			required: true,
		},
		{
			name: "package",
			type: "string",
			description: "Package name",
			required: true,
		},
		{
			name: "pattern",
			type: "string",
			description: "Regex pattern to search",
			required: true,
		},
	] as const)
	.flags({
		version: {
			type: "string",
			description: "Package version to search",
		},
		language: {
			type: "string",
			description: "Language filter",
		},
		"context-before": {
			type: "number",
			description: "Lines of context before each match",
		},
		"context-after": {
			type: "number",
			description: "Lines of context after each match",
		},
		"output-mode": {
			type: "string",
			description: "Output mode: content, files_with_matches, or count",
		},
		"head-limit": {
			type: "number",
			description: "Limit number of results",
		},
		"file-sha256": {
			type: "string",
			description: "File SHA256 filter to search a specific file",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		validateRegistry(args.registry);

		await withErrorHandling({ domain: "Package search" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: PackageSearchGrepRequest = {
				registry: args.registry,
				package_name: args.package,
				pattern: args.pattern,
			};

			if (flags.version) {
				payload.version = flags.version;
			}
			if (flags.language) {
				payload.language = flags.language;
			}
			if (flags["file-sha256"]) {
				payload.filename_sha256 = flags["file-sha256"];
			}
			if (flags["context-before"] !== undefined) {
				payload.b = flags["context-before"];
			}
			if (flags["context-after"] !== undefined) {
				payload.a = flags["context-after"];
			}
			if (flags["head-limit"] !== undefined) {
				payload.head_limit = flags["head-limit"];
			}
			if (flags["output-mode"]) {
				payload.output_mode = flags["output-mode"];
			}

			const result =
				await V2ApiPackageSearchService.packageSearchGrepV2V2PackageSearchGrepPost(
					payload,
				);

			fmt.output(result);
		});
	});

const hybridCommand = app
	.sub("hybrid")
	.meta({ description: "Hybrid semantic + keyword search over package source" })
	.args([
		{
			name: "registry",
			type: "string",
			description:
				"Package registry: npm, py_pi, crates_io, golang_proxy, ruby_gems",
			required: true,
		},
		{
			name: "package",
			type: "string",
			description: "Package name",
			required: true,
		},
		{
			name: "query",
			type: "string",
			description: "Semantic search query (1-5 queries, comma-separated)",
			required: true,
		},
	] as const)
	.flags({
		version: {
			type: "string",
			description: "Package version to search",
		},
		pattern: {
			type: "string",
			description: "Regex pattern pre-filter",
		},
		language: {
			type: "string",
			description: "Language filter",
		},
		"file-sha256": {
			type: "string",
			description: "File SHA256 filter to search a specific file",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		validateRegistry(args.registry);

		await withErrorHandling({ domain: "Package search" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			// Split comma-separated queries into an array (1-5 queries)
			const semanticQueries = args.query.split(",").map((s) => s.trim());

			const payload: PackageSearchHybridRequest = {
				registry: args.registry,
				package_name: args.package,
				semantic_queries: semanticQueries,
			};

			if (flags.version) {
				payload.version = flags.version;
			}
			if (flags.pattern) {
				payload.pattern = flags.pattern;
			}
			if (flags.language) {
				payload.language = flags.language;
			}
			if (flags["file-sha256"]) {
				payload.filename_sha256 = flags["file-sha256"];
			}

			const result =
				await V2ApiPackageSearchService.packageSearchHybridV2V2PackageSearchHybridPost(
					payload,
				);

			fmt.output(result);
		});
	});

const readCommand = app
	.sub("read")
	.meta({
		description:
			"Read specific lines from a package source file (max 200 lines)",
	})
	.args([
		{
			name: "registry",
			type: "string",
			description:
				"Package registry: npm, py_pi, crates_io, golang_proxy, ruby_gems",
			required: true,
		},
		{
			name: "package",
			type: "string",
			description: "Package name",
			required: true,
		},
		{
			name: "sha256",
			type: "string",
			description: "File SHA256 identifier (from grep results)",
			required: true,
		},
		{
			name: "start",
			type: "number",
			description: "Start line number (1-based)",
			required: true,
		},
		{
			name: "end",
			type: "number",
			description: "End line number (1-based, max 200 lines from start)",
			required: true,
		},
	] as const)
	.flags({
		version: {
			type: "string",
			description: "Package version",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		validateRegistry(args.registry);

		// Validate line range
		if (args.end - args.start > 200) {
			fmt.error("Maximum 200 lines per read request. Reduce the line range.");
			process.exit(1);
		}

		await withErrorHandling({ domain: "Package search" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: PackageSearchReadFileRequest = {
				registry: args.registry,
				package_name: args.package,
				filename_sha256: args.sha256,
				start_line: args.start,
				end_line: args.end,
			};

			if (flags.version) {
				payload.version = flags.version;
			}

			const result =
				await V2ApiPackageSearchService.packageSearchReadFileV2V2PackageSearchReadFilePost(
					payload,
				);

			// Display file content with line numbers if available
			const data = result as Record<string, unknown>;
			if (typeof data.content === "string") {
				const lines = data.content.split("\n");
				const startLine = args.start;
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

export const packagesCommand = annotate(
	app
		.sub("packages")
		.meta({ description: "Search npm, PyPI, crates.io, and Go packages" })
		.command(grepCommand)
		.command(hybridCommand)
		.command(readCommand),
	[
		"Search package source code without local installation. Registries: npm, py_pi, crates_io, golang_proxy, ruby_gems.",
		"Use `grep` first to find matches, then `read` for full file context with line ranges.",
		"Use `hybrid` for semantic + keyword search when grep patterns are too broad.",
	],
);
