import { readFileSync } from "node:fs";
import path from "node:path";
import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Known manifest filenames and their corresponding manifest_type values.
 */
const MANIFEST_TYPE_MAP: Record<string, string> = {
	"package.json": "package.json",
	"requirements.txt": "requirements.txt",
	"pyproject.toml": "pyproject.toml",
	"Cargo.toml": "Cargo.toml",
	"go.mod": "go.mod",
	"Gemfile": "Gemfile",
};

/**
 * Detect manifest_type from a filename.
 * Returns undefined if the filename is not recognized.
 */
function detectManifestType(filePath: string): string | undefined {
	const basename = path.basename(filePath);
	return MANIFEST_TYPE_MAP[basename];
}

/**
 * Make an authenticated API request and return the parsed JSON response.
 */
async function apiFetch(
	endpoint: string,
	options: RequestInit,
): Promise<unknown> {
	const baseUrl = await resolveBaseUrl();
	const token = OpenAPI.TOKEN;

	const response = await fetch(`${baseUrl}${endpoint}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			...options.headers,
		},
	});

	if (!response.ok) {
		const err = new Error(
			`Request failed with status ${response.status}`,
		);
		(err as Error & { status: number; body?: unknown }).status =
			response.status;
		try {
			(err as Error & { status: number; body?: unknown }).body =
				await response.json();
		} catch {}
		throw err;
	}

	return response.json();
}

// --- Subcommands ---

const analyzeCommand = app
	.sub("analyze")
	.meta({ description: "Analyze a manifest file to detect dependencies" })
	.args([
		{
			name: "file",
			type: "string",
			description: "Path to a manifest file (e.g., package.json, requirements.txt)",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		const filePath = path.resolve(args.file);

		await withErrorHandling({ domain: "Dependencies" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const manifestContent = readFileSync(filePath, "utf-8");
			const manifestType = detectManifestType(filePath);
			const filename = path.basename(filePath);

			const payload: Record<string, unknown> = {
				manifest_content: manifestContent,
				filename,
			};
			if (manifestType) {
				payload.manifest_type = manifestType;
			}

			const result = await apiFetch("/dependencies/analyze", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			const data = result as Record<string, unknown>;

			if (fmt.format !== "text") {
				fmt.output(result);
				return;
			}

			// Display summary
			const deps = Array.isArray(data.dependencies)
				? (data.dependencies as Array<Record<string, unknown>>)
				: [];
			const docMappings = Array.isArray(data.mappings)
				? (data.mappings as Array<Record<string, unknown>>)
				: [];

			const totalDeps = deps.length;
			const mapped = docMappings.filter(
				(m) => m.doc_url || m.documentation_url,
			).length;
			const unmapped = totalDeps - mapped;

			console.log(`Total dependencies: ${totalDeps}`);
			console.log(`Mapped:             ${mapped}`);
			console.log(`Unmapped:           ${unmapped}`);

			if (docMappings.length > 0) {
				console.log("\nMappings:");
				for (const mapping of docMappings) {
					const name = String(mapping.package_name ?? mapping.name ?? "");
					const url = String(
						mapping.doc_url ?? mapping.documentation_url ?? "(none)",
					);
					const confidence =
						mapping.confidence !== undefined
							? ` [confidence: ${mapping.confidence}]`
							: "";
					console.log(`  ${name} -> ${url}${confidence}`);
				}
			}
		});
	});

const subscribeCommand = app
	.sub("subscribe")
	.meta({
		description:
			"Subscribe to documentation for all dependencies in a manifest",
	})
	.args([
		{
			name: "file",
			type: "string",
			description: "Path to a manifest file (e.g., package.json, requirements.txt)",
			required: true,
		},
	] as const)
	.flags({
		dev: {
			type: "boolean",
			description: "Include dev dependencies",
		},
		"max-indexes": {
			type: "number",
			description: "Maximum number of new indexes to create (default: 150)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		const filePath = path.resolve(args.file);

		await withErrorHandling({ domain: "Dependencies" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const manifestContent = readFileSync(filePath, "utf-8");
			const manifestType = detectManifestType(filePath);
			const filename = path.basename(filePath);

			const payload: Record<string, unknown> = {
				manifest_content: manifestContent,
				filename,
			};
			if (manifestType) {
				payload.manifest_type = manifestType;
			}
			if (flags.dev !== undefined) {
				payload.include_dev_dependencies = flags.dev;
			}
			payload.max_new_indexes = flags["max-indexes"] ?? 150;

			const result = await apiFetch("/dependencies/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			const data = result as Record<string, unknown>;

			if (fmt.format !== "text") {
				fmt.output(result);
				return;
			}

			// Display subscription summary
			const instantAccess = Array.isArray(data.instant_access)
				? data.instant_access.length
				: (data.instant_access_count ?? 0);
			const waitForIndexing = Array.isArray(data.wait_for_indexing)
				? data.wait_for_indexing.length
				: (data.wait_for_indexing_count ?? 0);
			const startedIndexing = Array.isArray(data.started_indexing)
				? data.started_indexing.length
				: (data.started_indexing_count ?? 0);
			const notFound = Array.isArray(data.not_found)
				? data.not_found.length
				: (data.not_found_count ?? 0);
			const errors = Array.isArray(data.errors)
				? data.errors.length
				: (data.errors_count ?? 0);

			console.log("Subscription summary:");
			console.log(`  Instant access:     ${instantAccess}`);
			console.log(`  Wait for indexing:  ${waitForIndexing}`);
			console.log(`  Started indexing:   ${startedIndexing}`);
			console.log(`  Not found:          ${notFound}`);
			console.log(`  Errors:             ${errors}`);
		});
	});

const uploadCommand = app
	.sub("upload")
	.meta({ description: "Upload a manifest file via multipart form upload" })
	.args([
		{
			name: "file",
			type: "string",
			description: "Path to a manifest file to upload",
			required: true,
		},
	] as const)
	.flags({
		dev: {
			type: "boolean",
			description: "Include dev dependencies",
		},
		"max-indexes": {
			type: "number",
			description: "Maximum number of new indexes to create (default: 150)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		const filePath = path.resolve(args.file);

		await withErrorHandling({ domain: "Dependencies" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const fileContent = readFileSync(filePath);
			const filename = path.basename(filePath);

			const formData = new FormData();
			formData.append(
				"file",
				new Blob([fileContent]),
				filename,
			);

			if (flags.dev !== undefined) {
				formData.append(
					"include_dev_dependencies",
					String(flags.dev),
				);
			}
			if (flags["max-indexes"] !== undefined) {
				formData.append(
					"max_new_indexes",
					String(flags["max-indexes"]),
				);
			}

			const baseUrl = await resolveBaseUrl();
			const token = OpenAPI.TOKEN;

			const response = await fetch(`${baseUrl}/dependencies/upload`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
				},
				body: formData,
			});

			if (!response.ok) {
				const err = new Error(
					`Upload failed with status ${response.status}`,
				);
				(err as Error & { status: number; body?: unknown }).status =
					response.status;
				try {
					(err as Error & { status: number; body?: unknown }).body =
						await response.json();
				} catch {}
				throw err;
			}

			const result = await response.json();
			fmt.output(result);
		});
	});

// --- Parent command ---

export const depsCommand = annotate(
	app
		.sub("deps")
		.meta({ description: "Manage project dependencies and auto-subscribe to docs" })
		.command(analyzeCommand)
		.command(subscribeCommand)
		.command(uploadCommand),
	[
		"Analyze manifest files (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile) to detect dependencies.",
		"Use `subscribe` to auto-index documentation for all dependencies in a manifest.",
		"Use `upload` to send a manifest file directly via multipart form upload.",
	],
);
