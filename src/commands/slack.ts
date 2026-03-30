import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Helpers ---

async function slackFetch(
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
	.meta({ description: "Generate Slack OAuth install URL" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(flags, "/slack/install", {
				method: "POST",
			});
			fmt.output(result);
		});
	});

const installTokenCommand = app
	.sub("install-token")
	.meta({ description: "Register an external Slack bot token" })
	.flags({
		token: {
			type: "string",
			description: "Slack bot token (xoxb-...)",
			required: true,
		},
		name: {
			type: "string",
			description: "Display name for the installation",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Slack" }, async () => {
			const body: Record<string, unknown> = {
				bot_token: flags.token,
			};
			if (flags.name) {
				body.name = flags.name;
			}

			const result = await slackFetch(flags, "/slack/install/token", {
				method: "POST",
				body,
			});
			fmt.output(result);
		});
	});

const listCommand = app
	.sub("list")
	.meta({ description: "List Slack installations" })
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(flags, "/slack/installations");
			fmt.output(result);
		});
	});

const channelsCommand = app
	.sub("channels")
	.meta({ description: "List channels for a Slack workspace" })
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

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}/channels`,
			);
			fmt.output(result);
		});
	});

const grepCommand = app
	.sub("grep")
	.meta({ description: "Search Slack messages by pattern" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
		{
			name: "pattern",
			type: "string",
			description: "Search pattern",
			required: true,
		},
	] as const)
	.flags({
		channel: {
			type: "string",
			description: "Channel ID or name to search in",
		},
		limit: {
			type: "number",
			description: "Maximum number of results",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Slack" }, async () => {
			const body: Record<string, unknown> = {
				pattern: args.pattern,
			};
			if (flags.channel) {
				body.channel = flags.channel;
			}
			if (flags.limit !== undefined) {
				body.limit = flags.limit;
			}

			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}/grep`,
				{ method: "POST", body },
			);
			fmt.output(result);
		});
	});

const messagesCommand = app
	.sub("messages")
	.meta({ description: "Read recent Slack messages" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Installation ID",
			required: true,
		},
	] as const)
	.flags({
		channel: {
			type: "string",
			description: "Channel ID or name",
		},
		limit: {
			type: "number",
			description: "Maximum number of messages",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Slack" }, async () => {
			const query: Record<string, string> = {};
			if (flags.channel) {
				query.channel = flags.channel;
			}
			if (flags.limit !== undefined) {
				query.limit = String(flags.limit);
			}

			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}/messages`,
				{ query },
			);
			fmt.output(result);
		});
	});

const indexCommand = app
	.sub("index")
	.meta({ description: "Trigger re-index for a Slack installation" })
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

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}/index`,
				{ method: "POST" },
			);
			fmt.output(result);
		});
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "Get index status for a Slack installation" })
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

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}/status`,
			);
			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete a Slack installation" })
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

		await withErrorHandling({ domain: "Slack" }, async () => {
			const result = await slackFetch(
				flags,
				`/slack/installations/${args.id}`,
				{ method: "DELETE" },
			);
			fmt.output(result);
		});
	});

// --- Parent command ---

export const slackCommand = app
	.sub("slack")
	.meta({ description: "Manage Slack integrations" })
	.command(installCommand)
	.command(installTokenCommand)
	.command(listCommand)
	.command(channelsCommand)
	.command(grepCommand)
	.command(messagesCommand)
	.command(indexCommand)
	.command(statusCommand)
	.command(deleteCommand);
