import { configDir, createStore } from "@crustjs/store";

export const APP_NAME = "nia";
export const DEFAULT_BASE_URL = "https://apigcp.trynia.ai/v2";
export const EXPERIMENTAL_BASE_URL = "https://api.trynia.ai";

/**
 * Eden base URL for `POST /sandbox/search` and related routes.
 * Override with `NIA_SANDBOX_BASE_URL` when using a dev/staging API that serves sandbox (production may not expose it yet).
 */
export function resolveSandboxBaseUrl(): string {
	const raw = process.env.NIA_SANDBOX_BASE_URL;
	if (typeof raw === "string" && raw.trim().length > 0) {
		return raw.replace(/\/$/, "");
	}
	return EXPERIMENTAL_BASE_URL;
}

let experimentalOverride: boolean | undefined;

export const configStore = createStore({
	dirPath: configDir(APP_NAME),
	name: "config",
	fields: {
		apiKey: {
			type: "string",
			description: "Nia API key (managed via `nia auth login`)",
		},
		baseUrl: {
			type: "string",
			default: DEFAULT_BASE_URL,
			description: "Nia API base URL",
		},
		useExperimentalApi: {
			type: "boolean",
			default: false,
			description: "Use the experimental load-balanced API base URL",
		},
	},
});

export type NiaConfig = Awaited<ReturnType<typeof configStore.read>>;

export function getExperimentalOverride(): boolean | undefined {
	return experimentalOverride;
}

export function setExperimentalOverride(enabled?: boolean): void {
	experimentalOverride = enabled;
}

/**
 * The active config directory path.
 */
export function getConfigDirPath(): string {
	return configDir(APP_NAME);
}

/**
 * Mask an API key for display: shows "nia_****…ab12" or "****…ab12".
 * Returns "(not set)" if the key is undefined or empty.
 */
export function maskApiKey(key: string | undefined): string {
	if (!key) {
		return "(not set)";
	}

	const last4 = key.slice(-4);

	if (key.startsWith("nia_")) {
		return `nia_****...${last4}`;
	}

	return `****...${last4}`;
}

/**
 * Resolve the API key from the config resolution chain:
 * 1. Override (from CLI --api-key flag)
 * 2. NIA_API_KEY environment variable
 * 3. Config file (~/.config/nia/config.json)
 *
 * Returns undefined if no key is found anywhere.
 */
export async function resolveApiKey(
	override?: string,
): Promise<string | undefined> {
	if (override) {
		return override;
	}

	const envKey = process.env.NIA_API_KEY;
	if (envKey) {
		return envKey;
	}

	const config = await configStore.read();
	return config.apiKey;
}

/**
 * Resolve the API base URL from the config resolution chain:
 * 1. Override (from CLI flag)
 * 2. Per-invocation experimental override
 * 3. Persistent experimental mode
 * 4. NIA_BASE_URL environment variable
 * 5. Config file (~/.config/nia/config.json)
 *
 * Returns the default URL if no override is found.
 */
export async function resolveBaseUrl(override?: string): Promise<string> {
	if (override) {
		return override;
	}

	const config = await configStore.read();
	const runtimeOverride = getExperimentalOverride();
	const envBaseUrl = process.env.NIA_BASE_URL;

	if (runtimeOverride === true) {
		return EXPERIMENTAL_BASE_URL;
	}

	if (runtimeOverride === false) {
		if (envBaseUrl && envBaseUrl !== EXPERIMENTAL_BASE_URL) {
			return envBaseUrl;
		}

		if (config.baseUrl !== EXPERIMENTAL_BASE_URL) {
			return config.baseUrl;
		}

		return DEFAULT_BASE_URL;
	}

	if (config.useExperimentalApi) {
		return EXPERIMENTAL_BASE_URL;
	}

	if (envBaseUrl) {
		return envBaseUrl;
	}

	return config.baseUrl;
}

export async function persistExperimentalPreference(
	enabled: boolean,
): Promise<void> {
	await configStore.update((config) => ({
		...config,
		useExperimentalApi: enabled,
	}));
}
