import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let detectProjectInstructionsFile: typeof import("../../src/commands/vault.ts").detectProjectInstructionsFile;
let generateVaultAgentsMd: typeof import("../../src/commands/vault.ts").generateVaultAgentsMd;
let generateVaultBashExamples: typeof import("../../src/commands/vault.ts").generateVaultBashExamples;
let generateVaultSetupMd: typeof import("../../src/commands/vault.ts").generateVaultSetupMd;
let generateVaultSkillMd: typeof import("../../src/commands/vault.ts").generateVaultSkillMd;
let vaultSlug: typeof import("../../src/commands/vault.ts").vaultSlug;
let fetchAllAvailableVaultSources: typeof import("../../src/commands/vault.ts").fetchAllAvailableVaultSources;

beforeAll(async () => {
	mock.module("just-bash", () => ({
		Bash: class {
			async exec(): Promise<void> {
				return;
			}
		},
	}));

	const mod = await import("../../src/commands/vault.ts");
	detectProjectInstructionsFile = mod.detectProjectInstructionsFile;
	generateVaultAgentsMd = mod.generateVaultAgentsMd;
	generateVaultBashExamples = mod.generateVaultBashExamples;
	generateVaultSetupMd = mod.generateVaultSetupMd;
	generateVaultSkillMd = mod.generateVaultSkillMd;
	vaultSlug = mod.vaultSlug;
	fetchAllAvailableVaultSources = mod.fetchAllAvailableVaultSources;
});

afterAll(() => {
	mock.restore();
});

describe("vault command helpers", () => {
	test("vaultSlug normalizes arbitrary display names", () => {
		expect(vaultSlug("My Life Vault!! 2026")).toBe("my-life-vault-2026");
		expect(vaultSlug("___")).toBe("nia");
	});

	test("generateVaultBashExamples includes key command examples", () => {
		const text = generateVaultBashExamples("vault_123");
		expect(text).toContain("nia sources tree vault_123");
		expect(text).toContain("nia vault open vault_123");
		expect(text).toContain("nia vault ingest vault_123");
	});

	test("generateVaultAgentsMd embeds display name and vault id", () => {
		const text = generateVaultAgentsMd("vault_abc", "My Life");
		expect(text).toContain("## My Life Vault");
		expect(text).toContain("id: `vault_abc`");
		expect(text).toContain('The "leave alone" rule');
	});

	test("generateVaultSkillMd includes frontmatter and slugged name", () => {
		const text = generateVaultSkillMd("vault_xyz", "AI Research");
		expect(text).toContain("name: ai-research-vault");
		expect(text).toContain("id: vault_xyz");
		expect(text).toContain("## Critical rule: human edits are protected");
	});

	test("generateVaultSetupMd includes guided setup options", () => {
		const text = generateVaultSetupMd("vault_456", "Knowledge Base");
		expect(text).toContain("# Knowledge Base Vault — Setup");
		expect(text).toContain("Option 1: Agent instructions file");
		expect(text).toContain("Option 2: Skill");
		expect(text).toContain("Option 3: Both");
	});
});

describe("detectProjectInstructionsFile", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-vault-detect-"));
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("returns null when no candidate file exists", async () => {
		expect(await detectProjectInstructionsFile()).toBeNull();
	});

	test("prefers CLAUDE.md over other candidates", async () => {
		writeFileSync(path.join(tempDir, "AGENTS.md"), "# agents");
		writeFileSync(path.join(tempDir, "CLAUDE.md"), "# claude");

		expect(await detectProjectInstructionsFile()).toBe("CLAUDE.md");
	});

	test("falls back to AGENTS.md when CLAUDE.md is missing", async () => {
		writeFileSync(path.join(tempDir, "AGENTS.md"), "# agents");

		expect(await detectProjectInstructionsFile()).toBe("AGENTS.md");
	});
});

/**
 * Regression: `vault add-source --all` used to call the `/available-sources`
 * endpoint with `?limit=500`, which the backend now rejects (`limit <= 100`).
 * `fetchAllAvailableVaultSources` must page through results using an
 * injectable fetcher and never send `limit > 100`.
 */
describe("fetchAllAvailableVaultSources", () => {
	test("never requests limit > 100 (API cap regression)", async () => {
		type Q = Record<string, string | number | undefined> | undefined;
		const calls: Q[] = [];
		const fakeFetch = async (query: Q) => {
			calls.push(query);
			return { sources: [] };
		};

		await fetchAllAvailableVaultSources(fakeFetch);

		expect(calls.length).toBeGreaterThan(0);
		for (const q of calls) {
			expect(Number(q?.limit ?? 0)).toBeLessThanOrEqual(100);
		}
	});

	test("aggregates across pages and passes offset", async () => {
		type Q = Record<string, string | number | undefined> | undefined;
		const calls: Q[] = [];
		const fakeFetch = async (query: Q) => {
			calls.push(query);
			const offset = Number(query?.offset ?? 0);
			if (offset === 0) {
				return {
					sources: Array.from({ length: 100 }, (_, i) => ({
						id: `s-${i}`,
					})),
				};
			}
			if (offset === 100) {
				return {
					sources: Array.from({ length: 45 }, (_, i) => ({
						id: `s-${100 + i}`,
					})),
				};
			}
			return { sources: [] };
		};

		const sources = await fetchAllAvailableVaultSources(fakeFetch);

		expect(sources).toHaveLength(145);
		expect(calls).toHaveLength(2);
		expect(Number(calls[0]?.limit)).toBeLessThanOrEqual(100);
		expect(Number(calls[0]?.offset ?? 0)).toBe(0);
		expect(Number(calls[1]?.offset)).toBe(100);
	});

	test("handles empty result set", async () => {
		const fakeFetch = async () => ({ sources: [] });
		const sources = await fetchAllAvailableVaultSources(fakeFetch);
		expect(sources).toEqual([]);
	});
});
