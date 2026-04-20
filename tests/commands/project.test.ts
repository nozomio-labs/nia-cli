/**
 * Regression tests for `commands/project.ts` source-picker pagination.
 *
 * The `nia project init` command used to call `cliSdk.sources.list({
 * limit: 200 })` in its `pickSources()` helper. The backend now rejects any
 * `limit > 100` with:
 *
 *     Validation error: query → limit: Input should be less than or equal to 100
 *
 * which broke `nia project init` at startup. These tests lock in the fix:
 * the command must never send `limit > 100`, must page through results,
 * and must aggregate items across pages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	fetchAllSourcesForPicker,
	runProjectInit,
} from "../../src/commands/project.ts";

type ListCall = { limit?: number; offset?: number };

function makeFakeSdk(pages: Array<{ items: Array<{ id: string }> }>): {
	sdk: {
		sources: {
			list: (params?: {
				limit?: number;
				offset?: number;
			}) => Promise<{ items: Array<{ id: string }> }>;
		};
	};
	calls: ListCall[];
} {
	const calls: ListCall[] = [];
	const sdk = {
		sources: {
			list: async (params?: { limit?: number; offset?: number }) => {
				calls.push({ limit: params?.limit, offset: params?.offset });
				const idx = (params?.offset ?? 0) / (params?.limit ?? 100);
				return pages[idx] ?? { items: [] };
			},
		},
	};
	return { sdk, calls };
}

describe("fetchAllSourcesForPicker", () => {
	test("never calls sources.list with limit > 100 (API cap regression)", async () => {
		const { sdk, calls } = makeFakeSdk([{ items: [{ id: "a" }] }]);

		await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);

		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) {
			expect(c.limit ?? 0).toBeLessThanOrEqual(100);
		}
	});

	test("aggregates sources across multiple pages", async () => {
		const page1 = {
			items: Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}` })),
		};
		const page2 = {
			items: Array.from({ length: 100 }, (_, i) => ({ id: `p2-${i}` })),
		};
		const page3 = {
			items: Array.from({ length: 7 }, (_, i) => ({ id: `p3-${i}` })),
		};
		const { sdk, calls } = makeFakeSdk([page1, page2, page3]);

		const items = await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);

		expect(items).toHaveLength(207);
		expect((items[0] as { id: string }).id).toBe("p1-0");
		expect((items[200] as { id: string }).id).toBe("p3-0");
		// Paginated, not one huge call.
		expect(calls).toHaveLength(3);
		expect(calls[0]?.offset).toBe(0);
		expect(calls[1]?.offset).toBe(100);
		expect(calls[2]?.offset).toBe(200);
	});

	test("returns [] when SDK reports no sources", async () => {
		const { sdk, calls } = makeFakeSdk([{ items: [] }]);
		const items = await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);
		expect(items).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.limit ?? 0).toBeLessThanOrEqual(100);
	});
});

// ---------------------------------------------------------------------------
// runProjectInit — behaviour regressions
//
// These tests lock in two properties that `nia project init` MUST honour:
//
//   1. It NEVER mutates or creates any agent-instructions file in the project
//      root (CLAUDE.md / AGENTS.md / GEMINI.md / CURSOR.md). The global `nia`
//      skill is now the sole delivery channel for nia.json guidance.
//
//   2. It NEVER calls `addLocalSource(cwd)` unless the user explicitly
//      selected the synthetic "This project folder" choice in the picker.
//      Automatic cwd registration was removed.
//
// The init command's core is factored into `runProjectInit()` with dependency
// injection for the picker + `addLocalSource` so we can test both properties
// without spinning up a real interactive prompt or hitting the daemon.
// ---------------------------------------------------------------------------

describe("runProjectInit", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "nia-project-init-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	});

	const INSTRUCTION_FILES = [
		"CLAUDE.md",
		"AGENTS.md",
		"GEMINI.md",
		"CURSOR.md",
	];

	test("does NOT create any instruction files when running non-interactively", async () => {
		let addLocalCalls = 0;
		await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: true,
			pickSources: async () => ({ sourceIds: [], registerCwd: false }),
			addLocalSource: async () => {
				addLocalCalls++;
				throw new Error("addLocalSource should not be called when --yes");
			},
			checkSkillInstalled: async () => true,
		});

		for (const name of INSTRUCTION_FILES) {
			const full = path.join(tmpDir, name);
			let exists = true;
			try {
				readFileSync(full, "utf8");
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
		}

		// nia.json must exist though.
		const manifest = JSON.parse(
			readFileSync(path.join(tmpDir, "nia.json"), "utf8"),
		);
		expect(manifest).toMatchObject({
			version: 1,
			sources: [],
			vaults: [],
			local: [],
		});
		expect(addLocalCalls).toBe(0);
	});

	test("does NOT preserve pre-existing CLAUDE.md content untouched (no append)", async () => {
		// If the user already had a CLAUDE.md, init must not append to it.
		const existing = "# My project\n\nSome notes.\n";
		const claudePath = path.join(tmpDir, "CLAUDE.md");
		// Pre-populate.
		mkdirSync(tmpDir, { recursive: true });
		await Bun.write(claudePath, existing);

		await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: true,
			pickSources: async () => ({ sourceIds: [], registerCwd: false }),
			addLocalSource: async () => {
				throw new Error("addLocalSource should not be called");
			},
			checkSkillInstalled: async () => true,
		});

		const after = readFileSync(claudePath, "utf8");
		expect(after).toBe(existing);
	});

	test("does NOT auto-register cwd as a local source when picker did not select it", async () => {
		let addLocalCalls = 0;
		await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: false,
			pickSources: async () => ({
				sourceIds: ["repo-xyz"],
				registerCwd: false,
			}),
			addLocalSource: async () => {
				addLocalCalls++;
				return { local_folder_id: "local_abc" };
			},
			checkSkillInstalled: async () => true,
		});

		expect(addLocalCalls).toBe(0);

		const manifest = JSON.parse(
			readFileSync(path.join(tmpDir, "nia.json"), "utf8"),
		);
		expect(manifest.sources).toEqual(["repo-xyz"]);
		expect(manifest.local).toEqual([]);
	});

	test("DOES register cwd as a local source when the picker selects the synthetic choice", async () => {
		let addLocalCalls = 0;
		let addLocalPath: string | undefined;
		await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: false,
			pickSources: async () => ({
				sourceIds: ["repo-xyz"],
				registerCwd: true,
			}),
			addLocalSource: async (p: string) => {
				addLocalCalls++;
				addLocalPath = p;
				return { local_folder_id: "local_abc" };
			},
			checkSkillInstalled: async () => true,
		});

		expect(addLocalCalls).toBe(1);
		expect(addLocalPath).toBe(tmpDir);

		const manifest = JSON.parse(
			readFileSync(path.join(tmpDir, "nia.json"), "utf8"),
		);
		expect(manifest.sources).toEqual(["repo-xyz"]);
		expect(manifest.local).toEqual([{ path: ".", id: "local_abc" }]);
	});

	test("includes skill install hint in output when skill is NOT installed", async () => {
		const result = await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: true,
			pickSources: async () => ({ sourceIds: [], registerCwd: false }),
			addLocalSource: async () => {
				throw new Error("unreachable");
			},
			checkSkillInstalled: async () => false,
		});

		expect(
			result.nextSteps.some((s: string) =>
				s.toLowerCase().includes("nia skill"),
			),
		).toBe(true);
	});

	test("omits skill install hint in output when skill IS installed", async () => {
		const result = await runProjectInit({
			cwd: tmpDir,
			force: false,
			yes: true,
			pickSources: async () => ({ sourceIds: [], registerCwd: false }),
			addLocalSource: async () => {
				throw new Error("unreachable");
			},
			checkSkillInstalled: async () => true,
		});

		expect(
			result.nextSteps.some((s: string) =>
				s.toLowerCase().includes("nia skill"),
			),
		).toBe(false);
	});

	test("refuses to overwrite existing nia.json without force", async () => {
		await Bun.write(
			path.join(tmpDir, "nia.json"),
			JSON.stringify({ version: 1, sources: [], vaults: [], local: [] }),
		);

		await expect(
			runProjectInit({
				cwd: tmpDir,
				force: false,
				yes: true,
				pickSources: async () => ({ sourceIds: [], registerCwd: false }),
				addLocalSource: async () => {
					throw new Error("unreachable");
				},
				checkSkillInstalled: async () => true,
			}),
		).rejects.toThrow(/already exists/);
	});
});
