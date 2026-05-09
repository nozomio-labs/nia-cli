import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { annotate } from "@crustjs/skills";
import { OpenAPI, type SourceCreateRequest } from "nia-ai-ts";
import { app } from "../app.ts";
import { buildLocalSourceStatuses } from "./local.ts";
import {
	SOURCE_UPLOAD_CONTENT_TYPES,
	resolveUploadContentType,
} from "./sources.ts";
import { resolveBaseUrl } from "../services/config.ts";
import {
	LocalApiError,
	addLocalSource,
	listLocalSources,
} from "../services/local/api.ts";
import { TYPE_FOLDER } from "../services/local/extractor.ts";
import { createCliSdk, createSdk } from "../services/sdk.ts";
import { createResponseError, withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

type AddTarget =
	| { kind: "folder"; path: string }
	| { kind: "file"; path: string; extension: string }
	| { kind: "url"; url: string }
	| { kind: "unknown"; input: string };
export const SUPPORTED_UPLOAD_CONTENT_TYPES = SOURCE_UPLOAD_CONTENT_TYPES;

export function resolveAddTarget(input: string): AddTarget {
	const normalizedInput = input.trim();
	const maybeUrl = parseHttpUrl(normalizedInput);
	if (maybeUrl) {
		return { kind: "url", url: maybeUrl };
	}

	const resolvedPath = path.resolve(normalizedInput);
	if (!existsSync(resolvedPath)) {
		return { kind: "unknown", input: normalizedInput };
	}

	const stat = statSync(resolvedPath);
	if (stat.isDirectory()) {
		return { kind: "folder", path: resolvedPath };
	}
	if (stat.isFile()) {
		return {
			kind: "file",
			path: resolvedPath,
			extension: path.extname(resolvedPath).toLowerCase(),
		};
	}

	return { kind: "unknown", input: normalizedInput };
}

function parseHttpUrl(value: string): string | null {
	try {
		const parsed = new URL(value);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return value;
		}
		return null;
	} catch {
		return null;
	}
}

function toActionableAddError(
	error: unknown,
	inputPath: string,
	detectedType: string,
): Error {
	if (error instanceof LocalApiError) {
		const statusDetail =
			typeof error.status === "number" ? ` (HTTP ${error.status})` : "";
		return new Error(
			`Failed to add source at ${inputPath}. Detected type: ${detectedType}. ${error.message}${statusDetail}`,
		);
	}

	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

async function uploadFileSource(options: {
	filePath: string;
	displayName?: string;
	apiKey?: string;
}): Promise<Record<string, unknown>> {
	const contentType = resolveUploadContentType(options.filePath);

	await createSdk({ apiKey: options.apiKey });
	const baseUrl = await resolveBaseUrl();
	const token = OpenAPI.TOKEN;

	const fileName = path.basename(options.filePath);
	const uploadUrlResponse = await fetch(`${baseUrl}/sources/upload-url`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			filename: fileName,
			content_type: contentType,
		}),
	});
	if (!uploadUrlResponse.ok) {
		throw await createResponseError(uploadUrlResponse, "Failed to get upload URL");
	}

	const uploadUrlResult = (await uploadUrlResponse.json()) as {
		upload_url: string;
		gcs_path: string;
	};

	const uploadResponse = await fetch(uploadUrlResult.upload_url, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
		},
		body: readFileSync(options.filePath),
	});
	if (!uploadResponse.ok) {
		throw await createResponseError(uploadResponse, "File upload failed");
	}

	const createBody: Record<string, unknown> = {
		gcs_path: uploadUrlResult.gcs_path,
	};
	if (options.displayName) {
		createBody.display_name = options.displayName;
	}

	const createResponse = await fetch(`${baseUrl}/sources`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(createBody),
	});
	if (!createResponse.ok) {
		throw await createResponseError(createResponse, "Source creation failed");
	}

	return (await createResponse.json()) as Record<string, unknown>;
}

const addSourceCommand = app
	.sub("add")
	.meta({
		description:
			"Quickly add a source from a folder path, file path, or URL",
	})
	.args([
		{
			name: "target",
			type: "string",
			description: "Folder path, file path, or URL to add",
			required: true,
		},
	] as const)
	.flags({
		name: {
			type: "string",
			description: "Optional display name for the created source",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		const apiKey = flags["api-key"] as string | undefined;

		await withErrorHandling({ domain: "Add source" }, async () => {
			const target = resolveAddTarget(args.target);

			if (target.kind === "folder") {
				try {
					const created = await addLocalSource(target.path, apiKey, {
						detectedType: TYPE_FOLDER,
						displayName: flags.name as string | undefined,
					});
					if (!created.local_folder_id) {
						throw new Error(
							"Add source request succeeded but returned no source ID.",
						);
					}
					fmt.output({
						id: created.local_folder_id,
						name: created.display_name ?? path.basename(target.path),
						path: target.path,
						type: created.detected_type ?? TYPE_FOLDER,
						next: `nia local sync ${created.local_folder_id}`,
					});
					return;
				} catch (error) {
					throw toActionableAddError(error, target.path, TYPE_FOLDER);
				}
			}

			if (target.kind === "file") {
				const result = await uploadFileSource({
					filePath: target.path,
					displayName: flags.name as string | undefined,
					apiKey,
				});
				fmt.output(result);
				return;
			}

			if (target.kind === "url") {
				const cliSdk = await createCliSdk({ apiKey });
				const createRequest: SourceCreateRequest = {
					type: "documentation",
					url: target.url,
				};
				if (flags.name) {
					createRequest.display_name = flags.name as string;
				}
				const result = await cliSdk.sources.create(createRequest);
				fmt.output(result);
				return;
			}

			throw new Error(
				`Could not determine how to add "${target.input}". Provide an existing folder path, an existing file path, or an http(s) URL.`,
			);
		});
	});

const statusCommand = app
	.sub("status")
	.meta({
		description:
			"Show local sources configured through `nia add` / `nia local add`",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Source status" }, async () => {
			const sources = await listLocalSources(flags["api-key"] as string | undefined);
			const rows = buildLocalSourceStatuses(sources);
			if (rows.length === 0) {
				fmt.info("No sources configured.");
				return;
			}
			fmt.output(rows, {
				columns: ["id", "name", "path", "type", "status"],
			});
		});
	});

export const addCommand = annotate(addSourceCommand, [
	"Use `nia add <folder-path>` to register local folders in one command.",
	"Use `nia add <file-path>` to upload supported files (.pdf, .csv, .xlsx).",
	"Use `nia status` to confirm local sources are configured and linked.",
]);

export { statusCommand };
