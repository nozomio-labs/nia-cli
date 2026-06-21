import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock SDK ---
//
// `packages grep` routes its result through `fmt.output()`, so it is a
// representative command for verifying that the global `--output` / `--json`
// flags reach the shared renderer.

const mockPackageSearchGrep = mock(() =>
	Promise.resolve({
		matches: [
			{
				file: "src/index.ts",
				line: 42,
				content: "export function createApp() {",
			},
		],
		total_matches: 1,
	}),
);

const mockCreateTracerJob = mock(() =>
	Promise.resolve({
		job_id: "tracer_job_abc123",
		status: "queued",
		query: "How does error handling work?",
	}),
);

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {};
		sources = {};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiPackageSearchService: {
		packageSearchGrepV2V2PackageSearchGrepPost: mockPackageSearchGrep,
	},
	GithubSearchService: {
		createTracerJobV2GithubTracerPost: mockCreateTracerJob,
	},
}));

// --- Import after mocking ---

import { depsCommand } from "../../src/commands/deps.ts";
import { packagesCommand } from "../../src/commands/packages.ts";
import { tracerCommand } from "../../src/commands/tracer.ts";

async function captureStdout(run: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const originalLog = console.log;
	console.log = ((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	}) as typeof console.log;

	try {
		await run();
	} finally {
		console.log = originalLog;
	}

	return lines.join("\n");
}

function grep(...extraArgv: string[]): Promise<void> {
	return packagesCommand.execute({
		argv: ["grep", "npm", "react", "useState", ...extraArgv],
	});
}

describe("global --output / --json flags", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_output_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		mockPackageSearchGrep.mockClear();
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("--output json renders parseable JSON", async () => {
		const stdout = await captureStdout(() => grep("--output", "json"));

		const parsed = JSON.parse(Bun.stripANSI(stdout));
		expect(parsed.total_matches).toBe(1);
		expect(parsed.matches[0].file).toBe("src/index.ts");
	});

	test("--json shorthand renders parseable JSON", async () => {
		const stdout = await captureStdout(() => grep("--json"));

		const parsed = JSON.parse(Bun.stripANSI(stdout));
		expect(parsed.matches[0].line).toBe(42);
	});

	// Asserts that `--output table` *routes* to the table renderer, not that the
	// rendering is pretty. `packages grep` returns nested data, so the renderer's
	// existing behavior shows the `matches` array as `[object Object]` and leaves
	// the `total_matches` header un-split (`Total_matches`). That is a pre-existing
	// renderer limitation for non-flat data, codified here only as a routing check.
	test("--output table renders an aligned table", async () => {
		const stdout = await captureStdout(() => grep("--output", "table"));
		const plain = Bun.stripANSI(stdout);

		expect(plain).toContain("Matches");
		expect(plain).toContain("Total_matches");
		expect(plain).toContain("|");
		expect(() => JSON.parse(plain)).toThrow();
	});

	test("defaults to human text when no format flag is passed", async () => {
		const stdout = await captureStdout(() => grep());
		const plain = Bun.stripANSI(stdout);

		expect(plain).toContain("total_matches: 1");
		expect(() => JSON.parse(plain)).toThrow();
	});
});

// Some commands branch on `fmt.format` to emit the raw API payload under
// `json`/`table` and skip their human-readable summary. `deps analyze` is one
// such command (`src/commands/deps.ts`): in text mode it prints a "Total
// dependencies: N" summary, and in any other format it returns the structured
// result untouched. This verifies that path is reached now that the format
// flags are wired.
describe("format-aware commands (deps analyze)", () => {
	const analyzeResult = {
		dependencies: [{ name: "react", version: "18.0.0" }],
		mappings: [{ package_name: "react", doc_url: "https://react.dev" }],
	};

	const originalFetch = globalThis.fetch;
	let manifestDir: string;
	let manifestPath: string;

	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_output_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		manifestDir = mkdtempSync(join(tmpdir(), "nia-deps-"));
		manifestPath = join(manifestDir, "package.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({ dependencies: { react: "18.0.0" } }),
		);

		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(analyzeResult),
			}),
		) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		try {
			rmSync(manifestDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	function analyze(...extraArgv: string[]): Promise<void> {
		return depsCommand.execute({
			argv: ["analyze", manifestPath, ...extraArgv],
		});
	}

	test("--json emits the raw structured payload, not the text summary", async () => {
		const stdout = await captureStdout(() => analyze("--json"));
		const plain = Bun.stripANSI(stdout);

		const parsed = JSON.parse(plain);
		expect(parsed.dependencies[0].name).toBe("react");
		expect(parsed.mappings[0].doc_url).toBe("https://react.dev");
		expect(plain).not.toContain("Total dependencies");
	});

	test("default text mode prints the human summary", async () => {
		const stdout = await captureStdout(() => analyze());
		const plain = Bun.stripANSI(stdout);

		expect(plain).toContain("Total dependencies: 1");
		expect(() => JSON.parse(plain)).toThrow();
	});
});

// Commands that route their full payload through `fmt.output()` also print a
// trailing human hint (e.g. how to stream a job). That hint is text-only:
// emitting it under a machine format would corrupt the JSON/table payload.
// `tracer run` is representative; `oracle run` and `extract` share the guard.
describe("machine formats suppress trailing hints (tracer run)", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_output_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		mockCreateTracerJob.mockClear();
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	function run(...extraArgv: string[]): Promise<void> {
		return tracerCommand.execute({
			argv: ["run", "How does error handling work?", ...extraArgv],
		});
	}

	test("--json emits a clean payload without the streaming hint", async () => {
		const stdout = await captureStdout(() => run("--json"));
		const plain = Bun.stripANSI(stdout);

		const parsed = JSON.parse(plain);
		expect(parsed.job_id).toBe("tracer_job_abc123");
		expect(plain).not.toContain("to watch progress");
	});

	test("default text mode still prints the streaming hint", async () => {
		const stdout = await captureStdout(() => run());
		const plain = Bun.stripANSI(stdout);

		expect(plain).toContain("nia tracer stream tracer_job_abc123");
	});
});
