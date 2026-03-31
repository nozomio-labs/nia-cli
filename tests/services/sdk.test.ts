import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { OpenAPI } from "nia-ai-ts";
import { configureOpenApi, createSdk } from "../../src/services/sdk.ts";
import {
	getConfigDirPath,
	resetConfig,
	setExperimentalOverride,
	writeConfig,
} from "../helpers/config-store.ts";

describe("sdk service", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}
		delete process.env.NIA_API_KEY;
		delete process.env.NIA_BASE_URL;
		setExperimentalOverride(undefined);
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		delete process.env.NIA_API_KEY;
		delete process.env.NIA_BASE_URL;
		setExperimentalOverride(undefined);
	});

	describe("createSdk", () => {
		test("throws when no API key is found", async () => {
			await expect(createSdk()).rejects.toThrow("No API key found");
		});

		test("throws with helpful message suggesting auth login", async () => {
			await expect(createSdk()).rejects.toThrow("nia auth login");
		});

		test("creates SDK with override API key", async () => {
			const sdk = await createSdk({ apiKey: "nia_test_key" });
			expect(sdk).toBeDefined();
			expect(sdk.search).toBeDefined();
			expect(sdk.sources).toBeDefined();
			expect(sdk.oracle).toBeDefined();
		});

		test("creates SDK with env var API key", async () => {
			process.env.NIA_API_KEY = "nia_from_env";
			const sdk = await createSdk();
			expect(sdk).toBeDefined();
		});

		test("creates SDK with config file API key", async () => {
			await writeConfig({
				apiKey: "nia_from_config",
				baseUrl: "https://apigcp.trynia.ai/v2",
				useExperimentalApi: false,
				output: undefined,
			});

			const sdk = await createSdk();
			expect(sdk).toBeDefined();
		});

		test("configures OpenAPI singleton with BASE and TOKEN", async () => {
			await createSdk({
				apiKey: "nia_test_123",
				baseUrl: "https://custom-api.com",
			});

			expect(OpenAPI.BASE).toBe("https://custom-api.com");
			expect(OpenAPI.TOKEN).toBe("nia_test_123");
		});

		test("uses default base URL when none specified", async () => {
			await createSdk({ apiKey: "nia_test_123" });
			expect(OpenAPI.BASE).toBe("https://apigcp.trynia.ai/v2");
		});

		test("uses experimental base URL when enabled in config", async () => {
			await writeConfig({
				apiKey: "nia_from_config",
				baseUrl: "https://custom.example.com",
				useExperimentalApi: true,
				output: undefined,
			});

			await createSdk();
			expect(OpenAPI.BASE).toBe("https://api.trynia.ai");
		});

		test("uses experimental base URL when runtime override is enabled", async () => {
			await writeConfig({
				apiKey: "nia_from_config",
				baseUrl: "https://configured.example.com",
				useExperimentalApi: false,
				output: undefined,
			});
			setExperimentalOverride(true);

			await createSdk();
			expect(OpenAPI.BASE).toBe("https://api.trynia.ai");
		});

		test("uses standard base URL when runtime override disables experimental mode", async () => {
			process.env.NIA_BASE_URL = "https://api.trynia.ai";
			await writeConfig({
				apiKey: "nia_from_config",
				baseUrl: "https://configured.example.com",
				useExperimentalApi: true,
				output: undefined,
			});
			setExperimentalOverride(false);

			await createSdk();
			expect(OpenAPI.BASE).toBe("https://configured.example.com");
		});

		test("override API key takes priority over env", async () => {
			process.env.NIA_API_KEY = "nia_env_key";
			await createSdk({ apiKey: "nia_override" });
			expect(OpenAPI.TOKEN).toBe("nia_override");
		});
	});

	describe("configureOpenApi", () => {
		test("sets OpenAPI BASE and TOKEN", () => {
			configureOpenApi("nia_key_123", "https://api.example.com");
			expect(OpenAPI.BASE).toBe("https://api.example.com");
			expect(OpenAPI.TOKEN).toBe("nia_key_123");
		});

		test("uses default base URL when not specified", () => {
			configureOpenApi("nia_key_456");
			expect(OpenAPI.BASE).toBe("https://apigcp.trynia.ai/v2");
			expect(OpenAPI.TOKEN).toBe("nia_key_456");
		});
	});
});
