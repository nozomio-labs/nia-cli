import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Helpers ---

async function xFetch(
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
		(err as any).status = response.status;
		throw err;
	}

	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

// --- Subcommands ---

const installCommand = app
	.sub("install")
	.meta({ description: "Create an X/Twitter installation" })
	.args([
		{
			name: "username",
			type: "string",
			description: "X/Twitter username",
			required: true,
		},
	] as const)
	.flags({
		token: {
			type: "string",
			description: "Bearer token for the X API (required)",
			required: true,
		},
		name: {
			type: "string",
			description: "Display name for the installation",
		},
		"max-results": {
			type: "number",
			description: "Maximum number of results to fetch",
		},
		replies: {
			type: "boolean",
			description: "Include replies",
		},
		retweets: {
			type: "boolean",
			description: "Include retweets",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "X" }, async () => {
			const body: Record<string, unknown> = {
				username: args.username,
				bearer_token: flags.token,
			};
			if (flags.name) {
				body.display_name = flags.name;
			}
			if (flags["max-results"] !== undefined) {
				body.max_results = flags["max-results"];
			}
			if (flags.replies !== undefined) {
				body.include_replies = flags.replies;
			}
			if (flags.retweets !== undefined) {
				body.include_retweets = flags.retweets;
			}

			const result = await xFetch(flags, "/x/installations", {
				method: "POST",
				body,
			});
			fmt.output(result);
		});
	});

const listCommand = app
	.sub("list")
	.meta({ description: "List X/Twitter installations" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "X" }, async () => {
			const result = await xFetch(flags, "/x/installations");
			fmt.output(result);
		});
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "Get index status for an X/Twitter installation" })
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

		await withErrorHandling({ domain: "X" }, async () => {
			const result = await xFetch(
				flags,
				`/x/installations/${args.id}/status`,
			);
			fmt.output(result);
		});
	});

const indexCommand = app
	.sub("index")
	.meta({ description: "Trigger index for an X/Twitter installation" })
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

		await withErrorHandling({ domain: "X" }, async () => {
			const result = await xFetch(
				flags,
				`/x/installations/${args.id}/index`,
				{ method: "POST" },
			);
			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete an X/Twitter installation" })
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

		await withErrorHandling({ domain: "X" }, async () => {
			const result = await xFetch(
				flags,
				`/x/installations/${args.id}`,
				{ method: "DELETE" },
			);
			fmt.output(result);
		});
	});

// --- Parent command ---

export const xCommand = app
	.sub("x")
	.meta({ description: "Manage X/Twitter integrations" })
	.command(installCommand)
	.command(listCommand)
	.command(statusCommand)
	.command(indexCommand)
	.command(deleteCommand);
