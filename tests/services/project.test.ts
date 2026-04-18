/**
 * Tests for `services/project.ts` — the per-project `nia.json` manifest service.
 *
 * Exercises:
 *   - `findProjectManifest` walks up from cwd and stops at root
 *   - `readManifest` normalizes legacy/incomplete shapes
 *   - `addSource` / `removeSource` are pure and deduplicate
 *   - `addLocalBinding` updates in place when the same path is re-added
 *   - `resolveScope` correctly classifies repo vs doc identifiers and surfaces
 *     the manifest path
 *   - `looksLikeRepository` matches owner/repo and known git hosts only
 *
 * The tests use bun's tmp directory and never touch a real cwd, so they're
 * safe to run in parallel and inside CI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	addLocalBinding,
	addSource,
	addVault,
	createEmptyManifest,
	findProjectManifest,
	looksLikeRepository,
	MANIFEST_FILENAME,
	type ProjectManifest,
	readManifest,
	removeLocalBinding,
	removeSource,
	removeVault,
	resolveScope,
	writeManifest,
} from "../../src/services/project.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "nia-project-test-"));
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("findProjectManifest", () => {
	test("returns null when no nia.json exists in cwd or any parent", () => {
		const result = findProjectManifest(tmpDir);
		expect(result).toBeNull();
	});

	test("returns the absolute path when nia.json is in the start dir", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(manifestPath, JSON.stringify(createEmptyManifest()), "utf8");

		const result = findProjectManifest(tmpDir);
		expect(result).toBe(manifestPath);
	});

	test("walks up to find nia.json in a parent directory", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(manifestPath, JSON.stringify(createEmptyManifest()), "utf8");

		const nested = path.join(tmpDir, "a", "b", "c");
		mkdirSync(nested, { recursive: true });

		const result = findProjectManifest(nested);
		expect(result).toBe(manifestPath);
	});

	test("does not descend — only looks up", () => {
		const childDir = path.join(tmpDir, "child");
		mkdirSync(childDir, { recursive: true });
		const childManifest = path.join(childDir, MANIFEST_FILENAME);
		writeFileSync(childManifest, JSON.stringify(createEmptyManifest()), "utf8");

		// From the parent, the child manifest is invisible
		const result = findProjectManifest(tmpDir);
		expect(result).toBeNull();
	});

	test("prefers the nearest manifest when both parent and start dir have one", () => {
		const parentManifest = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(
			parentManifest,
			JSON.stringify(createEmptyManifest("parent")),
			"utf8",
		);

		const childDir = path.join(tmpDir, "child");
		mkdirSync(childDir, { recursive: true });
		const childManifest = path.join(childDir, MANIFEST_FILENAME);
		writeFileSync(
			childManifest,
			JSON.stringify(createEmptyManifest("child")),
			"utf8",
		);

		const result = findProjectManifest(childDir);
		expect(result).toBe(childManifest);
	});
});

describe("readManifest", () => {
	test("normalizes a minimal legacy manifest", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(
			manifestPath,
			JSON.stringify({ sources: ["a", "b"] }),
			"utf8",
		);

		const manifest = readManifest(manifestPath);
		expect(manifest.sources).toEqual(["a", "b"]);
		expect(manifest.vaults).toEqual([]);
		expect(manifest.local).toEqual([]);
		expect(manifest.version).toBeGreaterThan(0);
		expect(manifest.defaults?.search_mode).toBe("scoped");
	});

	test("preserves $schema, version, and name when present", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		const input = {
			$schema: "https://example.com/schema.json",
			version: 7,
			name: "demo",
			sources: ["x"],
			vaults: [],
			local: [],
		};
		writeFileSync(manifestPath, JSON.stringify(input), "utf8");

		const manifest = readManifest(manifestPath);
		expect(manifest.$schema).toBe("https://example.com/schema.json");
		expect(manifest.version).toBe(7);
		expect(manifest.name).toBe("demo");
	});

	test("strips empty/duplicate string entries from arrays", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				sources: ["a", " a ", "", "  ", "b", "a"],
				vaults: ["v1", "v1", " v2 "],
			}),
			"utf8",
		);

		const manifest = readManifest(manifestPath);
		expect(manifest.sources).toEqual(["a", "b"]);
		expect(manifest.vaults).toEqual(["v1", "v2"]);
	});

	test("accepts both string and object local bindings", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				sources: [],
				vaults: [],
				local: ["./", { path: "./other", id: "lf_123" }],
			}),
			"utf8",
		);

		const manifest = readManifest(manifestPath);
		expect(manifest.local).toEqual([
			{ path: "./" },
			{ path: "./other", id: "lf_123" },
		]);
	});

	test("dedupes local bindings by path, preferring entries with an id", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(
			manifestPath,
			JSON.stringify({
				sources: [],
				vaults: [],
				local: [{ path: "./" }, { path: "./", id: "lf_123" }, { path: "./" }],
			}),
			"utf8",
		);

		const manifest = readManifest(manifestPath);
		expect(manifest.local).toEqual([{ path: "./", id: "lf_123" }]);
	});

	test("throws a friendly error on invalid JSON", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(manifestPath, "not json", "utf8");

		expect(() => readManifest(manifestPath)).toThrow(/not valid JSON/);
	});

	test("throws when the file contains a non-object root", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(manifestPath, JSON.stringify(["x", "y"]), "utf8");

		expect(() => readManifest(manifestPath)).toThrow(/JSON object/);
	});
});

describe("writeManifest", () => {
	test("writes a JSON file with trailing newline", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeManifest(manifestPath, createEmptyManifest("demo"));

		const round = readManifest(manifestPath);
		expect(round.name).toBe("demo");
		expect(round.sources).toEqual([]);
	});

	test("creates intermediate directories when needed", () => {
		const nested = path.join(tmpDir, "a", "b");
		const manifestPath = path.join(nested, MANIFEST_FILENAME);
		writeManifest(manifestPath, createEmptyManifest());

		const round = readManifest(manifestPath);
		expect(round.sources).toEqual([]);
	});
});

describe("addSource / removeSource", () => {
	const base: ProjectManifest = {
		version: 1,
		sources: ["a"],
		vaults: [],
		local: [],
	};

	test("addSource appends when not present", () => {
		const next = addSource(base, "b");
		expect(next.sources).toEqual(["a", "b"]);
		expect(base.sources).toEqual(["a"]); // input unchanged (purity)
	});

	test("addSource is a no-op when identifier already present", () => {
		const next = addSource(base, "a");
		expect(next.sources).toEqual(["a"]);
	});

	test("addSource trims whitespace and dedupes against the trimmed form", () => {
		const next = addSource(base, "  a  ");
		expect(next.sources).toEqual(["a"]);
	});

	test("addSource ignores empty/whitespace-only identifiers", () => {
		expect(addSource(base, "").sources).toEqual(["a"]);
		expect(addSource(base, "   ").sources).toEqual(["a"]);
	});

	test("removeSource drops a matching identifier", () => {
		const next = removeSource(base, "a");
		expect(next.sources).toEqual([]);
	});

	test("removeSource is a no-op when identifier is absent", () => {
		const next = removeSource(base, "missing");
		expect(next.sources).toEqual(["a"]);
	});
});

describe("addVault / removeVault", () => {
	const base: ProjectManifest = {
		version: 1,
		sources: [],
		vaults: ["v1"],
		local: [],
	};

	test("addVault dedupes", () => {
		expect(addVault(base, "v1").vaults).toEqual(["v1"]);
		expect(addVault(base, "v2").vaults).toEqual(["v1", "v2"]);
	});

	test("removeVault is a no-op when absent", () => {
		expect(removeVault(base, "missing").vaults).toEqual(["v1"]);
	});
});

describe("addLocalBinding / removeLocalBinding", () => {
	const base: ProjectManifest = {
		version: 1,
		sources: [],
		vaults: [],
		local: [{ path: "./" }],
	};

	test("addLocalBinding updates in place when the same path is re-added with an id", () => {
		const next = addLocalBinding(base, { path: "./", id: "lf_999" });
		expect(next.local).toEqual([{ path: "./", id: "lf_999" }]);
	});

	test("addLocalBinding appends when path differs", () => {
		const next = addLocalBinding(base, { path: "./other" });
		expect(next.local).toEqual([{ path: "./" }, { path: "./other" }]);
	});

	test("removeLocalBinding matches by path or id", () => {
		const populated: ProjectManifest = {
			...base,
			local: [
				{ path: "./", id: "lf_1" },
				{ path: "./other", id: "lf_2" },
			],
		};
		expect(removeLocalBinding(populated, "./").local).toEqual([
			{ path: "./other", id: "lf_2" },
		]);
		expect(removeLocalBinding(populated, "lf_2").local).toEqual([
			{ path: "./", id: "lf_1" },
		]);
	});
});

describe("looksLikeRepository", () => {
	test("matches owner/repo shorthand", () => {
		expect(looksLikeRepository("vercel/next.js")).toBe(true);
		expect(looksLikeRepository("openai/cookbook")).toBe(true);
	});

	test("matches known git host URLs", () => {
		expect(looksLikeRepository("https://github.com/vercel/next.js")).toBe(true);
		expect(looksLikeRepository("https://gitlab.com/foo/bar")).toBe(true);
		expect(looksLikeRepository("https://bitbucket.org/foo/bar")).toBe(true);
	});

	test("does not match doc URLs", () => {
		expect(looksLikeRepository("https://docs.stripe.com")).toBe(false);
		expect(looksLikeRepository("https://example.com/path")).toBe(false);
	});

	test("does not match UUIDs", () => {
		expect(looksLikeRepository("550e8400-e29b-41d4-a716-446655440000")).toBe(
			false,
		);
		expect(looksLikeRepository("src_abc123")).toBe(false);
	});

	test("does not match strings with dots before the slash (heuristic for hostnames)", () => {
		expect(looksLikeRepository("example.com/path")).toBe(false);
	});

	test("does not match leading or trailing slashes", () => {
		expect(looksLikeRepository("/abs/path")).toBe(false);
		expect(looksLikeRepository("foo/bar/")).toBe(false);
	});

	test("rejects empty input", () => {
		expect(looksLikeRepository("")).toBe(false);
		expect(looksLikeRepository("   ")).toBe(false);
	});
});

describe("resolveScope", () => {
	test("returns null when no manifest exists", () => {
		expect(resolveScope(tmpDir)).toBeNull();
	});

	test("classifies sources into repos vs docs", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeManifest(manifestPath, {
			version: 1,
			sources: [
				"vercel/next.js",
				"https://github.com/openai/cookbook",
				"https://docs.stripe.com",
				"src_abc123",
			],
			vaults: ["vault_1"],
			local: [{ path: "./", id: "lf_1" }],
		});

		const scope = resolveScope(tmpDir);
		expect(scope).not.toBeNull();
		expect(scope?.manifestPath).toBe(manifestPath);
		expect(scope?.repos).toEqual([
			"vercel/next.js",
			"https://github.com/openai/cookbook",
		]);
		expect(scope?.docs).toEqual(["https://docs.stripe.com", "src_abc123"]);
		expect(scope?.localFolders).toEqual(["lf_1"]);
		expect(scope?.vaults).toEqual(["vault_1"]);
	});

	test("local bindings without an id are not surfaced as localFolders", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeManifest(manifestPath, {
			version: 1,
			sources: [],
			vaults: [],
			local: [{ path: "./" }],
		});

		const scope = resolveScope(tmpDir);
		expect(scope?.localFolders).toEqual([]);
	});

	test("returns null on a malformed manifest instead of crashing", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeFileSync(manifestPath, "{ invalid json", "utf8");

		expect(resolveScope(tmpDir)).toBeNull();
	});

	test("walks up from a nested cwd", () => {
		const manifestPath = path.join(tmpDir, MANIFEST_FILENAME);
		writeManifest(manifestPath, {
			version: 1,
			sources: ["a"],
			vaults: [],
			local: [],
		});

		const nested = path.join(tmpDir, "a", "b");
		mkdirSync(nested, { recursive: true });

		const scope = resolveScope(nested);
		expect(scope?.manifestPath).toBe(manifestPath);
		expect(scope?.docs).toEqual(["a"]);
	});
});
