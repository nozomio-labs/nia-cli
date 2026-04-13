import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
	extractSqliteSource,
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

describe("SQLite extraction", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-sqlite-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts from WAL-mode database", () => {
		const dbPath = path.join(tempDir, "test.sqlite");
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT)");
		db.run("INSERT INTO notes (title, body) VALUES ('Hello', 'World')");
		db.run("INSERT INTO notes (title, body) VALUES ('Second', 'Note here')");
		db.close();

		const result = extractSqliteSource(dbPath, "test-wal");
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBeGreaterThanOrEqual(2);

		const contents = result.files.map((f) => f.content);
		expect(contents.some((c) => c.includes("Hello"))).toBe(true);
		expect(contents.some((c) => c.includes("Second"))).toBe(true);
	});

	test("extracts from WAL-mode database even without WAL file", () => {
		const dbPath = path.join(tempDir, "checkpointed.sqlite");
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
		db.run("INSERT INTO items (name) VALUES ('apple')");
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();

		// Remove WAL and SHM files to simulate a checkpointed DB
		for (const suffix of ["-wal", "-shm"]) {
			try {
				rmSync(dbPath + suffix, { force: true });
			} catch {
				// may not exist
			}
		}

		const result = extractSqliteSource(dbPath, "test-no-wal");
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBeGreaterThanOrEqual(1);
		expect(result.files.some((f) => f.content.includes("apple"))).toBe(true);
	});

	test("handles directory with nested SQLite", () => {
		const subDir = path.join(tempDir, "nested", "deep");
		mkdirSync(subDir, { recursive: true });

		const dbPath = path.join(subDir, "data.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, text TEXT)");
		db.run("INSERT INTO entries (text) VALUES ('found it')");
		db.close();

		const result = extractSqliteSource(tempDir, "test-nested");
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBeGreaterThanOrEqual(1);
		expect(result.files.some((f) => f.content.includes("found it"))).toBe(true);
	});

	test("returns error for nonexistent path", () => {
		const result = extractSqliteSource(
			path.join(tempDir, "does-not-exist.sqlite"),
			"test-missing",
		);
		expect(result.files).toHaveLength(0);
		expect(result.stats.error).toContain("path does not exist");
	});
});
