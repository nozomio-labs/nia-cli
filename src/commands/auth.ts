import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import { runBrowserDeviceLogin } from "../services/auth/browser-login.ts";
import {
	normalizeUsageSummary,
	printCliUsage,
} from "../services/compat/usage.ts";
import {
	configStore,
	getConfigDirPath,
	maskApiKey,
	resolveBaseUrl,
} from "../services/config.ts";
import { configureOpenApi, createCliSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";

const loginCommand = app
	.sub("login")
	.meta({
		description:
			"Authenticate with the Nia platform (browser sign-in, or pass --api-key)",
	})
	.flags({
		"api-key": {
			type: "string",
			description:
				"API key (skips browser — use for manual entry or non-interactive/CI)",
		},
	})
	.run(async ({ flags }) => {
		let apiKey = flags["api-key"];

		if (!apiKey) {
			const canPrompt = process.stdout.isTTY && process.stdin.isTTY;
			if (!canPrompt) {
				console.error("Non-interactive mode requires --api-key <value>");
				console.error("Example: nia auth login --api-key nia_your_api_key");
				process.exit(1);
			}

			apiKey = await runBrowserDeviceLogin();
			if (!apiKey) {
				console.error("No API key provided. Aborting.");
				process.exit(1);
			}
		}

		// Validate the API key by calling the usage endpoint
		configureOpenApi(apiKey, await resolveBaseUrl());

		await withErrorHandling({ domain: "Authentication" }, async () => {
			const cliSdk = await createCliSdk({ apiKey });
			const usage = await cliSdk.usage.getSummary();

			// API key is valid — store it in config
			await configStore.update((config) => ({
				...config,
				apiKey: apiKey,
			}));

			console.log(`Authenticated successfully. API key: ${maskApiKey(apiKey)}`);
			printCliUsage(normalizeUsageSummary(usage));
		});
	});

const logoutCommand = app
	.sub("logout")
	.meta({ description: "Remove stored API credentials" })
	.run(async () => {
		await configStore.update((config) => ({
			...config,
			apiKey: undefined,
		}));

		const configPath = `${getConfigDirPath()}/config.json`;
		console.log(`Logged out. API key removed from ${configPath}`);

		if (process.env.NIA_API_KEY) {
			console.log("Note: NIA_API_KEY environment variable is still set.");
		}
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "Check authentication status" })
	.run(async () => {
		// Determine the API key source and value
		const envKey = process.env.NIA_API_KEY;
		const config = await configStore.read();
		const configKey = config.apiKey;

		let source: "env" | "config" | "none";
		let activeKey: string | undefined;

		if (envKey) {
			source = "env";
			activeKey = envKey;
		} else if (configKey) {
			source = "config";
			activeKey = configKey;
		} else {
			source = "none";
			activeKey = undefined;
		}

		if (!activeKey) {
			console.log("Authenticated: no");
			console.log("API key source: none");
			console.log("Run `nia auth login` to authenticate.");
			return;
		}

		console.log("Authenticated: yes");
		console.log(`API key source: ${source}`);
		console.log(`API key: ${maskApiKey(activeKey)}`);

		// Try to fetch plan info
		configureOpenApi(activeKey, await resolveBaseUrl());

		try {
			const cliSdk = await createCliSdk({ apiKey: activeKey });
			const usage = await cliSdk.usage.getSummary();
			printCliUsage(normalizeUsageSummary(usage));
		} catch {
			console.log("Could not fetch plan info (API key may be invalid).");
		}
	});

/**
 * Resolve the source of the currently active API key.
 * Exported for testing.
 */
export function resolveApiKeySource(
	envKey?: string,
	configKey?: string,
): "env" | "config" | "none" {
	if (envKey) return "env";
	if (configKey) return "config";
	return "none";
}

export const authCommand = annotate(
	app
		.sub("auth")
		.meta({ description: "Authenticate with the Nia platform" })
		.command(loginCommand)
		.command(logoutCommand)
		.command(statusCommand),
	[
		"Interactive login opens the browser; after a timeout, you can paste an API key. Override wait with `NIA_AUTH_BROWSER_TIMEOUT_MS` (ms).",
		"Pass `--api-key` to skip the browser and set a key directly (including in CI).",
		"Device flow uses `NIA_BACKEND_URL` / `NIA_APP_URL` when set.",
		"The `NIA_API_KEY` environment variable can also be used and takes precedence over stored config.",
		"Use `nia auth status` to check current authentication state and plan info.",
	],
);
