import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { experimentalModePlugin } from "../../src/plugins/experimental.ts";
import { DEFAULT_BASE_URL, EXPERIMENTAL_BASE_URL } from "../../src/services/config.ts";
import {
	getConfigDirPath,
	readConfig,
	resetConfig,
	resolveBaseUrl,
	setExperimentalOverride,
	writeConfig,
} from "../helpers/config-store.ts";

describe("experimental mode plugin", () => {
	beforeEach(async () => {
		setExperimentalOverride(undefined);
		delete process.env.NIA_BASE_URL;
		try {
			await resetConfig();
		} catch {
			// Ignore
		}
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		delete process.env.NIA_BASE_URL;
		setExperimentalOverride(undefined);
	});

	test("applies --experimental only within the active command invocation", async () => {
		await writeConfig({
			apiKey: undefined,
			baseUrl: DEFAULT_BASE_URL,
			useExperimentalApi: false,
		});

		const plugin = experimentalModePlugin();
		let baseUrlInCommand = "";

		await plugin.middleware?.(
			{
				input: {
					flags: {
						experimental: true,
					},
				},
			} as never,
			async () => {
				baseUrlInCommand = await resolveBaseUrl();
				expect((await readConfig()).useExperimentalApi).toBe(false);
			},
		);

		expect(baseUrlInCommand).toBe(EXPERIMENTAL_BASE_URL);
		expect((await readConfig()).useExperimentalApi).toBe(false);
		expect(await resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
	});

	test("applies --no-experimental only within the active command invocation", async () => {
		await writeConfig({
			apiKey: undefined,
			baseUrl: "https://configured.example.com",
			useExperimentalApi: true,
		});

		const plugin = experimentalModePlugin();
		let baseUrlInCommand = "";

		await plugin.middleware?.(
			{
				input: {
					flags: {
						experimental: false,
					},
				},
			} as never,
			async () => {
				baseUrlInCommand = await resolveBaseUrl();
				expect((await readConfig()).useExperimentalApi).toBe(true);
			},
		);

		expect(baseUrlInCommand).toBe("https://configured.example.com");
		expect((await readConfig()).useExperimentalApi).toBe(true);
		expect(await resolveBaseUrl()).toBe(EXPERIMENTAL_BASE_URL);
	});
});
