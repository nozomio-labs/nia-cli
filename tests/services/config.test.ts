import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	maskApiKey,
	persistExperimentalPreference,
	readConfig,
	resetConfig,
	resolveApiKey,
	resolveBaseUrl,
	updateConfig,
	writeConfig,
} from "../helpers/config-store.ts";

describe("config service", () => {
	beforeEach(async () => {
		// Clean the config file before each test
		try {
			await resetConfig();
		} catch {
			// Ignore errors if file doesn't exist
		}
	});

	afterEach(() => {
		// Clean up any leftover config files
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}

		// Clean env vars set by tests
		delete process.env.NIA_API_KEY;
		delete process.env.NIA_BASE_URL;
	});

	describe("readConfig", () => {
		test("returns defaults when no config file exists", async () => {
			const config = await readConfig();
			expect(config.apiKey).toBeUndefined();
			expect(config.baseUrl).toBe("https://apigcp.trynia.ai/v2");
			expect(config.useExperimentalApi).toBe(false);
		});

		test("reads persisted config values", async () => {
			await writeConfig({
				apiKey: "nia_test1234",
				baseUrl: "https://custom.api.com",
				useExperimentalApi: true,
			});

			const config = await readConfig();
			expect(config.apiKey).toBe("nia_test1234");
			expect(config.baseUrl).toBe("https://custom.api.com");
			expect(config.useExperimentalApi).toBe(true);
		});
	});

	describe("writeConfig", () => {
		test("persists config and reads it back", async () => {
			await writeConfig({
				apiKey: "nia_abcd",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: true,
			});

			const config = await readConfig();
			expect(config.apiKey).toBe("nia_abcd");
			expect(config.baseUrl).toBe("https://apigcp.trynia.ai/v2");
			expect(config.useExperimentalApi).toBe(true);
		});
	});

	describe("updateConfig", () => {
		test("atomically updates a single field", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
			});

			await updateConfig((current) => ({
				...current,
				baseUrl: "https://custom.example.com",
			}));

			const config = await readConfig();
			expect(config.baseUrl).toBe("https://custom.example.com");
		});
	});

	describe("resetConfig", () => {
		test("resets to defaults", async () => {
			await writeConfig({
				apiKey: "nia_secret",
				baseUrl: "https://custom.com",
				useExperimentalApi: true,
			});

			await resetConfig();

			const config = await readConfig();
			expect(config.apiKey).toBeUndefined();
			expect(config.baseUrl).toBe("https://apigcp.trynia.ai/v2");
			expect(config.useExperimentalApi).toBe(false);
		});
	});

	describe("maskApiKey", () => {
		test("masks key starting with nia_ prefix", () => {
			expect(maskApiKey("nia_abcdef1234")).toBe("nia_****...1234");
		});

		test("masks key without nia_ prefix", () => {
			expect(maskApiKey("sk-abcdefgh5678")).toBe("****...5678");
		});

		test("returns '(not set)' for undefined", () => {
			expect(maskApiKey(undefined)).toBe("(not set)");
		});

		test("returns '(not set)' for empty string", () => {
			expect(maskApiKey("")).toBe("(not set)");
		});

		test("handles short keys", () => {
			expect(maskApiKey("ab")).toBe("****...ab");
		});
	});

	describe("resolveApiKey", () => {
		test("returns override when provided", async () => {
			process.env.NIA_API_KEY = "env_key";
			await writeConfig({
				apiKey: "config_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
			});

			const key = await resolveApiKey("override_key");
			expect(key).toBe("override_key");
		});

		test("returns env var when no override", async () => {
			process.env.NIA_API_KEY = "env_key";
			await writeConfig({
				apiKey: "config_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
			});

			const key = await resolveApiKey();
			expect(key).toBe("env_key");
		});

		test("returns config key when no override or env", async () => {
			delete process.env.NIA_API_KEY;
			await writeConfig({
				apiKey: "config_key",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
			});

			const key = await resolveApiKey();
			expect(key).toBe("config_key");
		});

		test("returns undefined when no key found anywhere", async () => {
			delete process.env.NIA_API_KEY;

			const key = await resolveApiKey();
			expect(key).toBeUndefined();
		});

		test("priority: override > env > config", async () => {
			process.env.NIA_API_KEY = "env";
			await writeConfig({
				apiKey: "config",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
			});

			// Override beats env and config
			expect(await resolveApiKey("override")).toBe("override");

			// Env beats config
			expect(await resolveApiKey()).toBe("env");

			// Config used as fallback
			delete process.env.NIA_API_KEY;
			expect(await resolveApiKey()).toBe("config");
		});
	});

	describe("resolveBaseUrl", () => {
		test("returns override when provided", async () => {
			const url = await resolveBaseUrl("https://custom.com");
			expect(url).toBe("https://custom.com");
		});

		test("returns config value when no override", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://configured.com",
				useExperimentalApi: false,
			});

			const url = await resolveBaseUrl();
			expect(url).toBe("https://configured.com");
		});

		test("returns default when no override or config", async () => {
			const url = await resolveBaseUrl();
			expect(url).toBe("https://apigcp.trynia.ai/v2");
		});

		test("prefers experimental base URL over env and config", async () => {
			process.env.NIA_BASE_URL = "https://env.example.com";
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://configured.com",
				useExperimentalApi: true,
			});

			const url = await resolveBaseUrl();
			expect(url).toBe("https://api.trynia.ai");
		});

		test("override still beats experimental mode", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://configured.com",
				useExperimentalApi: true,
			});

			const url = await resolveBaseUrl("https://override.example.com");
			expect(url).toBe("https://override.example.com");
		});
	});

	describe("persistExperimentalPreference", () => {
		test("persists experimental mode when enabled", async () => {
			await persistExperimentalPreference(true);

			const config = await readConfig();
			expect(config.useExperimentalApi).toBe(true);
		});

		test("persists disable when set to false", async () => {
			await writeConfig({
				apiKey: undefined,
				baseUrl: "https://configured.com",
				useExperimentalApi: true,
			});

			await persistExperimentalPreference(false);

			const config = await readConfig();
			expect(config.useExperimentalApi).toBe(false);
		});
	});

	describe("getConfigDirPath", () => {
		test("returns a path under XDG_CONFIG_HOME", () => {
			const dir = getConfigDirPath();
			expect(process.env.XDG_CONFIG_HOME).toBeDefined();
			expect(dir).toContain(String(process.env.XDG_CONFIG_HOME));
			expect(dir).toContain("nia");
		});
	});
});
