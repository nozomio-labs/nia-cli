import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	extractFolderIncremental,
	MAX_FILE_SIZE_BYTES,
} from "../../src/services/local/extractor.ts";

describe("local extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-local-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts text files and skips hidden/build/binary files", () => {
		mkdirSync(path.join(tempDir, "src"), { recursive: true });
		mkdirSync(path.join(tempDir, ".git"), { recursive: true });
		mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });

		writeFileSync(path.join(tempDir, "src", "main.ts"), "console.log('hi');");
		writeFileSync(path.join(tempDir, ".git", "config"), "[core]");
		writeFileSync(path.join(tempDir, "node_modules", "x.js"), "ignored");
		writeFileSync(path.join(tempDir, "image.png"), Buffer.from([0, 1, 2, 3]));

		const result = extractFolderIncremental(tempDir);

		expect(result.files.map((file) => file.path.replace(/\\/g, "/"))).toEqual([
			"src/main.ts",
		]);
		expect(result.stats.extracted).toBe(1);
	});

	test("supports incremental cursoring by last_mtime and last_path", async () => {
		writeFileSync(path.join(tempDir, "a.ts"), "const a = 1;");
		writeFileSync(path.join(tempDir, "b.ts"), "const b = 2;");

		const first = extractFolderIncremental(tempDir);
		expect(first.files).toHaveLength(2);

		const second = extractFolderIncremental(tempDir, first.cursor);
		expect(second.files).toHaveLength(0);

		await Bun.sleep(20);
		writeFileSync(path.join(tempDir, "c.ts"), "const c = 3;");
		const now = new Date();
		utimesSync(path.join(tempDir, "c.ts"), now, now);

		const third = extractFolderIncremental(tempDir, first.cursor);
		expect(third.files.map((file) => file.path)).toEqual(["c.ts"]);
	});

	test("skips oversized files", () => {
		writeFileSync(
			path.join(tempDir, "huge.ts"),
			"a".repeat(MAX_FILE_SIZE_BYTES + 1),
		);

		const result = extractFolderIncremental(tempDir);
		expect(result.files).toHaveLength(0);
		expect(result.stats.skip_details).toEqual({ too_large: 1 });
	});
});
