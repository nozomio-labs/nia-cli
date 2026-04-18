/**
 * Tests for `applyProjectScope` — the auto-scope helper that injects
 * `nia.json` bindings into `nia search query` payloads when the user didn't
 * pass any of `--repos`/`--docs`/`--local-folders` flags.
 *
 * Behavioral contract under test:
 *   - User-supplied filters ALWAYS win, even if a manifest exists.
 *   - `--no-scope` (passed as `noScope: true`) bypasses the manifest.
 *   - When auto-scope kicks in, the result reflects the manifest's classified
 *     scope and `scopeApplied: true` so the caller can print a transparent
 *     stderr line.
 *   - When no manifest exists, the function is a no-op.
 *
 * The tests construct a real `nia.json` in a tmp dir and `chdir` into it for
 * the duration of each test, since `applyProjectScope` walks up from cwd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyProjectScope } from "../../src/commands/search.ts";
import { MANIFEST_FILENAME } from "../../src/services/project.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "nia-autoscope-test-"));
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function writeFixtureManifest(sources: string[], localId?: string): void {
	const body = {
		version: 1,
		sources,
		vaults: [],
		local: localId ? [{ path: ".", id: localId }] : [],
	};
	writeFileSync(
		path.join(tmpDir, MANIFEST_FILENAME),
		JSON.stringify(body),
		"utf8",
	);
}

describe("applyProjectScope", () => {
	test("no-op when no manifest is present", () => {
		const result = applyProjectScope({});
		expect(result.scope).toBeNull();
		expect(result.scopeApplied).toBe(false);
		expect(result.repos).toBeUndefined();
		expect(result.docs).toBeUndefined();
		expect(result.localFolders).toBeUndefined();
	});

	test("ignores manifest when --repos was passed", () => {
		writeFixtureManifest(["vercel/next.js"]);

		const result = applyProjectScope({ repos: "openai/cookbook" });
		expect(result.scopeApplied).toBe(false);
		expect(result.repos).toBe("openai/cookbook");
	});

	test("ignores manifest when --docs was passed", () => {
		writeFixtureManifest(["vercel/next.js"]);

		const result = applyProjectScope({ docs: "https://docs.example.com" });
		expect(result.scopeApplied).toBe(false);
		expect(result.docs).toBe("https://docs.example.com");
	});

	test("ignores manifest when --local-folders was passed", () => {
		writeFixtureManifest([]);

		const result = applyProjectScope({ localFolders: "lf_explicit" });
		expect(result.scopeApplied).toBe(false);
		expect(result.localFolders).toBe("lf_explicit");
	});

	test("ignores manifest when noScope is true", () => {
		writeFixtureManifest(["vercel/next.js"]);

		const result = applyProjectScope({ noScope: true });
		expect(result.scopeApplied).toBe(false);
		expect(result.repos).toBeUndefined();
	});

	test("auto-injects classified scope when no flags were passed", () => {
		writeFixtureManifest(
			["vercel/next.js", "https://docs.stripe.com", "src_doc_uuid"],
			"lf_local_id",
		);

		const result = applyProjectScope({});
		expect(result.scopeApplied).toBe(true);
		expect(result.scope).not.toBeNull();
		expect(result.repos).toBe("vercel/next.js");
		expect(result.docs).toBe("https://docs.stripe.com,src_doc_uuid");
		expect(result.localFolders).toBe("lf_local_id");
	});

	test("scopeApplied is false when manifest exists but is empty", () => {
		writeFixtureManifest([]);

		const result = applyProjectScope({});
		expect(result.scope).not.toBeNull();
		expect(result.scopeApplied).toBe(false);
		expect(result.repos).toBeUndefined();
		expect(result.docs).toBeUndefined();
		expect(result.localFolders).toBeUndefined();
	});

	test("treats an empty-string flag as 'not passed' so manifest still wins", () => {
		writeFixtureManifest(["vercel/next.js"]);

		// crustjs may surface unset string flags as empty strings; the helper
		// must treat those the same as `undefined` so the manifest still wins.
		const result = applyProjectScope({
			repos: "",
			docs: "   ",
			localFolders: "",
		});
		expect(result.scopeApplied).toBe(true);
		expect(result.repos).toBe("vercel/next.js");
	});
});
