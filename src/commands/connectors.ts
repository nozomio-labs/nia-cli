import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Helpers ---

async function connectorFetch(
	flags: { "api-key"?: string },
	path: string,
	options: { method?: string; body?: unknown } = {},
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

	const response = await fetch(`${baseUrl}${path}`, init);
	if (!response.ok) {
		const err = new Error(`Request failed with status ${response.status}`);
		(err as Error & { status: number }).status = response.status;
		throw err;
	}

	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

// --- Subcommands ---

const listCommand = app
	.sub("list")
	.meta({ description: "List available connector types" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(flags, "/connectors");
			fmt.output(result);
		});
	});

const installationsCommand = app
	.sub("installations")
	.meta({ description: "List connector installations" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(flags, "/connectors/installations");
			fmt.output(result);
		});
	});

const installCommand = app
	.sub("install")
	.meta({ description: "Install a connector" })
	.args([
		{
			name: "type",
			type: "string",
			description: "Connector type to install",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(
				flags,
				`/connectors/${args.type}/install`,
				{ method: "POST" },
			);
			fmt.output(result);
		});
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "Get connector installation status" })
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

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(
				flags,
				`/connectors/installations/${args.id}/status`,
			);
			fmt.output(result);
		});
	});

const indexCommand = app
	.sub("index")
	.meta({ description: "Trigger indexing for a connector installation" })
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

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(
				flags,
				`/connectors/installations/${args.id}/index`,
				{ method: "POST" },
			);
			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete a connector installation" })
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

		await withErrorHandling({ domain: "Connectors" }, async () => {
			const result = await connectorFetch(
				flags,
				`/connectors/installations/${args.id}`,
				{ method: "DELETE" },
			);
			fmt.output(result);
		});
	});

// --- Parent command ---

export const connectorsCommand = annotate(
	app
		.sub("connectors")
		.meta({ description: "Manage connector integrations" })
		.command(listCommand)
		.command(installationsCommand)
		.command(installCommand)
		.command(statusCommand)
		.command(indexCommand)
		.command(deleteCommand),
	[
		"Generic connector management for third-party integrations (Airtable, Notion, etc.).",
		"Use `list` to see available connector types, `install` to set one up.",
		"For Slack, Google Drive, and X use the dedicated `nia slack`, `nia gdrive`, `nia x` commands instead.",
	],
);
