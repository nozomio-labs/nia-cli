import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Helpers ---

async function gdriveFetch(
	flags: { "api-key"?: string },
	path: string,
	options: {
		method?: string;
		body?: unknown;
		query?: Record<string, string>;
	} = {},
): Promise<unknown> {
	await createSdk({ apiKey: flags["api-key"] });
	const baseUrl = await resolveBaseUrl();
	const token = OpenAPI.TOKEN;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
	};

	const init: RequestInit = {
		method: options.method ?? "GET",
		headers,
	};

	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(options.body);
	}

	let url = `${baseUrl}${path}`;
	if (options.query) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(options.query)) {
			if (value !== undefined && value !== "") {
				params.set(key, value);
			}
		}
		const qs = params.toString();
		if (qs) {
			url += `?${qs}`;
		}
	}

	const response = await fetch(url, init);
	if (!response.ok) {
		const err = new Error(`Request failed with status ${response.status}`);
		(err as Error & { status: number }).status = response.status;
		throw err;
	}

	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

// --- Subcommands ---

const installCommand = app
	.sub("install")
	.meta({ description: "Generate Google Drive OAuth install URL" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const result = await gdriveFetch(flags, "/google-drive/install", {
				method: "POST",
			});
			fmt.output(result);
		});
	});

const listCommand = app
	.sub("list")
	.meta({ description: "List Google Drive installations" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const result = await gdriveFetch(flags, "/google-drive/installations");
			fmt.output(result);
		});
	});

const browseCommand = app
	.sub("browse")
	.meta({ description: "Browse Google Drive items" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.flags({
		folder: {
			type: "string",
			description: "Folder ID to browse",
		},
		query: {
			type: "string",
			description: "Search query",
		},
		"page-size": {
			type: "number",
			description: "Number of items per page",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const query: Record<string, string> = {};
			if (flags.folder) {
				query.folder_id = flags.folder;
			}
			if (flags.query) {
				query.q = flags.query;
			}
			if (flags["page-size"] !== undefined) {
				query.page_size = String(flags["page-size"]);
			}

			const result = await gdriveFetch(
				flags,
				`/google-drive/installations/${args.id}/browse`,
				{ query },
			);
			fmt.output(result);
		});
	});

const indexCommand = app
	.sub("index")
	.meta({ description: "Trigger index for a Google Drive installation" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.flags({
		files: {
			type: "string",
			description: "Comma-separated file IDs to index",
		},
		folders: {
			type: "string",
			description: "Comma-separated folder IDs to index",
		},
		name: {
			type: "string",
			description: "Display name for the index",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const body: Record<string, unknown> = {};
			if (flags.files) {
				body.file_ids = flags.files.split(",").map((s) => s.trim());
			}
			if (flags.folders) {
				body.folder_ids = flags.folders.split(",").map((s) => s.trim());
			}
			if (flags.name) {
				body.name = flags.name;
			}

			const result = await gdriveFetch(
				flags,
				`/google-drive/installations/${args.id}/index`,
				{ method: "POST", body },
			);
			fmt.output(result);
		});
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "Get index status for a Google Drive installation" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const result = await gdriveFetch(
				flags,
				`/google-drive/installations/${args.id}/status`,
			);
			fmt.output(result);
		});
	});

const syncCommand = app
	.sub("sync")
	.meta({ description: "Trigger sync for a Google Drive installation" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.flags({
		"force-full": {
			type: "boolean",
			description: "Force a full sync instead of incremental",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const body: Record<string, unknown> = {};
			if (flags["force-full"] !== undefined) {
				body.force_full = flags["force-full"];
			}

			const result = await gdriveFetch(
				flags,
				`/google-drive/installations/${args.id}/sync`,
				{ method: "POST", body },
			);
			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete a Google Drive installation" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Google Drive" }, async () => {
			const result = await gdriveFetch(
				flags,
				`/google-drive/installations/${args.id}`,
				{ method: "DELETE" },
			);
			fmt.output(result);
		});
	});

// --- Parent command ---

export const gdriveCommand = app
	.sub("gdrive")
	.meta({ description: "Manage Google Drive integrations" })
	.command(installCommand)
	.command(listCommand)
	.command(browseCommand)
	.command(indexCommand)
	.command(statusCommand)
	.command(syncCommand)
	.command(deleteCommand);
