import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runRootCommand } from "../src/app.ts";
import {
	getConfigDirPath,
	readConfig,
	resetConfig,
	setExperimentalOverride,
	writeConfig,
} from "./helpers/config-store.ts";

describe("root command experimental persistence", () => {
	beforeEach(async () => {
		setExperimentalOverride(undefined);
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
		setExperimentalOverride(undefined);
	});

	test("persists experimental mode when run from the root command", async () => {
		const originalLog = console.log;
		const messages: string[] = [];
		console.log = ((message: string) => {
			messages.push(message);
		}) as typeof console.log;

		try {
			await runRootCommand({
				command: {} as never,
				flags: { experimental: true },
			});
		} finally {
			console.log = originalLog;
		}

		expect((await readConfig()).useExperimentalApi).toBe(true);
		expect(messages).toEqual([
			"Experimental API enabled. Future commands will use the experimental API.",
		]);
	});

	test("persists disabling experimental mode when run from the root command", async () => {
		await writeConfig({
			apiKey: undefined,
			baseUrl: "https://configured.example.com",
			useExperimentalApi: true,
		});
		const originalLog = console.log;
		const messages: string[] = [];
		console.log = ((message: string) => {
			messages.push(message);
		}) as typeof console.log;

		try {
			await runRootCommand({
				command: {} as never,
				flags: { experimental: false },
			});
		} finally {
			console.log = originalLog;
		}

		expect((await readConfig()).useExperimentalApi).toBe(false);
		expect(messages).toEqual([
			"Experimental API disabled. Future commands will use the standard API.",
		]);
	});
});
