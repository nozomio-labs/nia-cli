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
import { extractWhatsApp } from "../../src/services/local/extractors/whatsapp.ts";
import { extractNotes } from "../../src/services/local/extractors/notes.ts";
import { extractContacts } from "../../src/services/local/extractors/contacts.ts";
import { extractReminders } from "../../src/services/local/extractors/reminders.ts";
import { extractPodcasts } from "../../src/services/local/extractors/podcasts.ts";
import { extractPhotos } from "../../src/services/local/extractors/photos.ts";
import { extractScreenTime } from "../../src/services/local/extractors/screentime.ts";

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

// Cocoa timestamp helper: seconds since 2001-01-01
function cocoaTimestamp(date: Date): number {
	return date.getTime() / 1000 - 978307200;
}

describe("WhatsApp extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-whatsapp-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts text messages grouped by chat and time window", () => {
		const dbPath = path.join(tempDir, "ChatStorage.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZWACHATSESSION (
			Z_PK INTEGER PRIMARY KEY,
			ZPARTNERNAME TEXT
		)`);
		db.run(`CREATE TABLE ZWAPROFILEPUSHNAME (
			Z_PK INTEGER PRIMARY KEY,
			ZJID TEXT,
			ZPUSHNAME TEXT
		)`);
		db.run(`CREATE TABLE ZWAMESSAGE (
			Z_PK INTEGER PRIMARY KEY,
			ZTEXT TEXT,
			ZMESSAGEDATE REAL,
			ZCHATSESSION INTEGER,
			ZSENDERJIDFULL TEXT,
			ZISFROMME INTEGER,
			ZMESSAGETYPE INTEGER
		)`);

		db.run("INSERT INTO ZWACHATSESSION (Z_PK, ZPARTNERNAME) VALUES (1, 'Alice')");
		db.run("INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, ZJID, ZPUSHNAME) VALUES (1, 'alice@s.whatsapp.net', 'Alice')");

		const baseDate = cocoaTimestamp(new Date("2024-06-15T10:00:00Z"));
		db.run(
			"INSERT INTO ZWAMESSAGE (Z_PK, ZTEXT, ZMESSAGEDATE, ZCHATSESSION, ZSENDERJIDFULL, ZISFROMME, ZMESSAGETYPE) VALUES (1, 'Hello!', ?, 1, 'alice@s.whatsapp.net', 0, 0)",
			[baseDate],
		);
		db.run(
			"INSERT INTO ZWAMESSAGE (Z_PK, ZTEXT, ZMESSAGEDATE, ZCHATSESSION, ZSENDERJIDFULL, ZISFROMME, ZMESSAGETYPE) VALUES (2, 'Hi back!', ?, 1, NULL, 1, 0)",
			[baseDate + 60],
		);
		db.close();

		const result = extractWhatsApp(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].path).toContain("whatsapp/Alice/");
		expect(result.files[0].content).toContain("Hello!");
		expect(result.files[0].content).toContain("Hi back!");
		expect(result.files[0].content).toContain("Chat: Alice");
		expect(result.cursor.last_message_date).toBeDefined();
	});

	test("returns empty for nonexistent path", () => {
		const result = extractWhatsApp("/tmp/nonexistent-wa.sqlite");
		expect(result.files).toHaveLength(0);
		expect(result.stats.error).toBeDefined();
	});

	test("supports cursor-based incremental extraction", () => {
		const dbPath = path.join(tempDir, "ChatStorage.sqlite");
		const db = new Database(dbPath);

		db.run("CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT)");
		db.run("CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, ZJID TEXT, ZPUSHNAME TEXT)");
		db.run(`CREATE TABLE ZWAMESSAGE (
			Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZMESSAGEDATE REAL,
			ZCHATSESSION INTEGER, ZSENDERJIDFULL TEXT, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER
		)`);

		db.run("INSERT INTO ZWACHATSESSION (Z_PK, ZPARTNERNAME) VALUES (1, 'Bob')");
		const d1 = cocoaTimestamp(new Date("2024-01-01T10:00:00Z"));
		const d2 = cocoaTimestamp(new Date("2024-01-02T10:00:00Z"));
		db.run("INSERT INTO ZWAMESSAGE VALUES (1, 'First', ?, 1, NULL, 1, 0)", [d1]);
		db.run("INSERT INTO ZWAMESSAGE VALUES (2, 'Second', ?, 1, NULL, 1, 0)", [d2]);
		db.close();

		const first = extractWhatsApp(dbPath);
		expect(first.files.length).toBeGreaterThan(0);

		const second = extractWhatsApp(dbPath, first.cursor);
		expect(second.files).toHaveLength(0);
	});
});

describe("Notes extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-notes-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts notes with title and folder", () => {
		const dbPath = path.join(tempDir, "NoteStore.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZICCLOUDSYNCINGOBJECT (
			Z_PK INTEGER PRIMARY KEY,
			ZTITLE1 TEXT,
			ZTITLE2 TEXT,
			ZFOLDER INTEGER,
			ZMODIFICATIONDATE1 REAL,
			ZISPASSWORDPROTECTED INTEGER DEFAULT 0,
			ZMARKEDFORDELETION INTEGER DEFAULT 0
		)`);
		db.run(`CREATE TABLE ZICNOTEDATA (
			Z_PK INTEGER PRIMARY KEY,
			ZNOTE INTEGER,
			ZDATA BLOB
		)`);

		const modDate = cocoaTimestamp(new Date("2024-03-15T12:00:00Z"));

		// folder row
		db.run("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2) VALUES (10, 'Work')");
		// note row
		db.run(
			"INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE1, ZFOLDER, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZMARKEDFORDELETION) VALUES (1, 'My Note', 10, ?, 0, 0)",
			[modDate],
		);
		db.close();

		const result = extractNotes(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].path).toContain("notes/Work/My Note_1.txt");
		expect(result.files[0].content).toContain("Title: My Note");
		expect(result.files[0].content).toContain("Folder: Work");
		expect(result.cursor.last_note_id).toBe(1);
	});

	test("skips password-protected and deleted notes", () => {
		const dbPath = path.join(tempDir, "NoteStore.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZICCLOUDSYNCINGOBJECT (
			Z_PK INTEGER PRIMARY KEY, ZTITLE1 TEXT, ZTITLE2 TEXT,
			ZFOLDER INTEGER, ZMODIFICATIONDATE1 REAL,
			ZISPASSWORDPROTECTED INTEGER DEFAULT 0,
			ZMARKEDFORDELETION INTEGER DEFAULT 0
		)`);
		db.run("CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB)");

		const d = cocoaTimestamp(new Date("2024-01-01T00:00:00Z"));
		db.run("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 'Protected', NULL, NULL, ?, 1, 0)", [d]);
		db.run("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (2, 'Deleted', NULL, NULL, ?, 0, 1)", [d]);
		db.close();

		const result = extractNotes(dbPath);
		expect(result.files).toHaveLength(0);
	});
});

describe("Contacts extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-contacts-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts contacts with phones and emails", () => {
		const dbPath = path.join(tempDir, "AddressBook-v22.abcddb");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZABCDRECORD (
			Z_PK INTEGER PRIMARY KEY,
			ZFIRSTNAME TEXT,
			ZLASTNAME TEXT,
			ZORGANIZATION TEXT,
			ZJOBTITLE TEXT,
			ZNOTE TEXT,
			ZMODIFICATIONDATE REAL
		)`);
		db.run(`CREATE TABLE ZABCDPHONENUMBER (
			Z_PK INTEGER PRIMARY KEY,
			ZOWNER INTEGER,
			ZFULLNUMBER TEXT
		)`);
		db.run(`CREATE TABLE ZABCDEMAILADDRESS (
			Z_PK INTEGER PRIMARY KEY,
			ZOWNER INTEGER,
			ZADDRESS TEXT
		)`);

		const mod = cocoaTimestamp(new Date("2024-05-01T00:00:00Z"));
		db.run("INSERT INTO ZABCDRECORD VALUES (1, 'John', 'Doe', 'Acme', 'Engineer', 'VIP client', ?)", [mod]);
		db.run("INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+1234567890')");
		db.run("INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'john@example.com')");
		db.close();

		const result = extractContacts(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].content).toContain("Name: John Doe");
		expect(result.files[0].content).toContain("+1234567890");
		expect(result.files[0].content).toContain("john@example.com");
		expect(result.files[0].content).toContain("Organization: Acme");
		expect(result.files[0].path).toContain("contacts/John Doe_1.txt");
	});

	test("finds databases in Sources subdirectories", () => {
		const sourceDir = path.join(tempDir, "Sources", "ABC123");
		mkdirSync(sourceDir, { recursive: true });
		const dbPath = path.join(sourceDir, "AddressBook-v22.abcddb");
		const db = new Database(dbPath);

		db.run("CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZJOBTITLE TEXT, ZNOTE TEXT, ZMODIFICATIONDATE REAL)");
		db.run("CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT)");
		db.run("CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT)");

		db.run("INSERT INTO ZABCDRECORD VALUES (1, 'Jane', 'Smith', NULL, NULL, NULL, ?)", [cocoaTimestamp(new Date("2024-01-01T00:00:00Z"))]);
		db.close();

		const result = extractContacts(tempDir);
		expect(result.files.length).toBe(1);
		expect(result.files[0].content).toContain("Jane Smith");
	});
});

describe("Reminders extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-reminders-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts reminders with list and priority", () => {
		const dbPath = path.join(tempDir, "reminders.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZREMCDCALENDAR (
			Z_PK INTEGER PRIMARY KEY,
			ZTITLE1 TEXT
		)`);
		db.run(`CREATE TABLE ZREMCDREMINDER (
			Z_PK INTEGER PRIMARY KEY,
			ZTITLE1 TEXT,
			ZNOTES TEXT,
			ZLIST INTEGER,
			ZPRIORITY INTEGER,
			ZCOMPLETED INTEGER DEFAULT 0,
			ZDUEDATE REAL,
			ZMODIFIEDDATE REAL
		)`);

		db.run("INSERT INTO ZREMCDCALENDAR VALUES (1, 'Shopping')");
		const mod = cocoaTimestamp(new Date("2024-04-01T09:00:00Z"));
		const due = cocoaTimestamp(new Date("2024-04-02T12:00:00Z"));
		db.run("INSERT INTO ZREMCDREMINDER VALUES (1, 'Buy milk', 'Organic only', 1, 1, 0, ?, ?)", [due, mod]);
		db.close();

		const result = extractReminders(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].content).toContain("Title: Buy milk");
		expect(result.files[0].content).toContain("List: Shopping");
		expect(result.files[0].content).toContain("Priority: High");
		expect(result.files[0].content).toContain("Organic only");
		expect(result.files[0].path).toContain("reminders/Shopping/Buy milk_1.txt");
	});

	test("handles missing ZREMCDREMINDER table gracefully", () => {
		const dbPath = path.join(tempDir, "empty.sqlite");
		const db = new Database(dbPath);
		db.run("CREATE TABLE dummy (id INTEGER)");
		db.close();

		const result = extractReminders(dbPath);
		expect(result.files).toHaveLength(0);
	});

	test("finds databases in Stores subdirectories", () => {
		const storeDir = path.join(tempDir, "Stores", "store1");
		mkdirSync(storeDir, { recursive: true });
		const dbPath = path.join(storeDir, "reminders.sqlite");
		const db = new Database(dbPath);

		db.run("CREATE TABLE ZREMCDREMINDER (Z_PK INTEGER PRIMARY KEY, ZTITLE1 TEXT, ZNOTES TEXT, ZLIST INTEGER, ZPRIORITY INTEGER, ZCOMPLETED INTEGER DEFAULT 0, ZDUEDATE REAL, ZMODIFIEDDATE REAL)");
		db.run("INSERT INTO ZREMCDREMINDER VALUES (1, 'Test', NULL, NULL, NULL, 0, NULL, ?)", [cocoaTimestamp(new Date("2024-01-01T00:00:00Z"))]);
		db.close();

		const result = extractReminders(tempDir);
		expect(result.files.length).toBe(1);
		expect(result.files[0].content).toContain("Test");
	});
});

describe("Podcasts extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-podcasts-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts episodes with show info and stripped HTML", () => {
		const dbPath = path.join(tempDir, "MTLibrary.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE MTPODCAST (
			Z_PK INTEGER PRIMARY KEY,
			ZTITLE TEXT,
			ZAUTHOR TEXT
		)`);
		db.run(`CREATE TABLE MTEPISODE (
			Z_PK INTEGER PRIMARY KEY,
			ZTITLE TEXT,
			ZASSETDESCRIPTION TEXT,
			ZPODCAST INTEGER,
			ZPUBDATE REAL,
			ZDURATION REAL,
			ZPLAYCOUNT INTEGER
		)`);

		db.run("INSERT INTO MTPODCAST VALUES (1, 'Tech Talk', 'Jane Host')");
		const pubDate = cocoaTimestamp(new Date("2024-07-01T08:00:00Z"));
		db.run(
			"INSERT INTO MTEPISODE VALUES (1, 'Episode 42', '<p>Great <b>episode</b> about AI</p>', 1, ?, 3665, 2)",
			[pubDate],
		);
		db.close();

		const result = extractPodcasts(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].content).toContain("Episode: Episode 42");
		expect(result.files[0].content).toContain("Show: Tech Talk");
		expect(result.files[0].content).toContain("Author: Jane Host");
		expect(result.files[0].content).toContain("Duration: 1h 1m");
		expect(result.files[0].content).toContain("Great episode about AI");
		expect(result.files[0].content).not.toContain("<p>");
		expect(result.files[0].path).toContain("podcasts/Tech Talk/");
		expect(result.cursor.last_pub_date).toBeDefined();
	});
});

describe("Photos extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-photos-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts photo metadata grouped by date", () => {
		const dbPath = path.join(tempDir, "Photos.sqlite");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZASSET (
			Z_PK INTEGER PRIMARY KEY,
			ZFILENAME TEXT,
			ZDATECREATED REAL,
			ZMODIFICATIONDATE REAL,
			ZLATITUDE REAL,
			ZLONGITUDE REAL,
			ZWIDTH INTEGER,
			ZHEIGHT INTEGER,
			ZFAVORITE INTEGER DEFAULT 0,
			ZTRASHEDSTATE INTEGER DEFAULT 0,
			ZHIDDEN INTEGER DEFAULT 0
		)`);
		db.run(`CREATE TABLE ZADDITIONALASSETATTRIBUTES (
			Z_PK INTEGER PRIMARY KEY,
			ZASSET INTEGER,
			ZCAMERAMAKE TEXT,
			ZCAMERAMODEL TEXT,
			ZLENSMODEL TEXT,
			ZORIGINALFILESIZE INTEGER
		)`);

		const created = cocoaTimestamp(new Date("2024-06-20T14:30:00Z"));
		const modified = cocoaTimestamp(new Date("2024-06-20T14:30:00Z"));
		db.run("INSERT INTO ZASSET VALUES (1, 'IMG_0001.HEIC', ?, ?, 37.7749, -122.4194, 4032, 3024, 1, 0, 0)", [created, modified]);
		db.run("INSERT INTO ZADDITIONALASSETATTRIBUTES VALUES (1, 1, 'Apple', 'iPhone 15 Pro', '6.765mm f/1.78', 5242880)");

		// Also insert a trashed photo that should be skipped
		db.run("INSERT INTO ZASSET VALUES (2, 'IMG_0002.HEIC', ?, ?, NULL, NULL, 1920, 1080, 0, 1, 0)", [created, modified]);
		db.close();

		const result = extractPhotos(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].path).toBe("photos/2024-06-20.txt");
		expect(result.files[0].content).toContain("IMG_0001.HEIC");
		expect(result.files[0].content).toContain("4032x3024");
		expect(result.files[0].content).toContain("GPS: 37.774900, -122.419400");
		expect(result.files[0].content).toContain("Apple iPhone 15 Pro");
		expect(result.files[0].content).toContain("Favorite: Yes");
		expect(result.files[0].content).not.toContain("IMG_0002");
	});
});

describe("Screen Time extractor", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-screentime-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("extracts daily usage summaries grouped by app", () => {
		const dbPath = path.join(tempDir, "knowledgeC.db");
		const db = new Database(dbPath);

		db.run(`CREATE TABLE ZOBJECT (
			Z_PK INTEGER PRIMARY KEY,
			ZSTREAMNAME TEXT,
			ZVALUESTRING TEXT,
			ZSTARTDATE REAL,
			ZENDDATE REAL
		)`);

		// Cocoa timestamps for Screen Time (seconds since 2001-01-01)
		const startBase = cocoaTimestamp(new Date("2024-08-10T09:00:00Z"));
		db.run("INSERT INTO ZOBJECT VALUES (1, '/app/usage', 'com.apple.safari', ?, ?)", [startBase, startBase + 1800]);
		db.run("INSERT INTO ZOBJECT VALUES (2, '/app/usage', 'com.apple.safari', ?, ?)", [startBase + 3600, startBase + 5400]);
		db.run("INSERT INTO ZOBJECT VALUES (3, '/app/usage', 'com.slack.Slack', ?, ?)", [startBase + 1800, startBase + 2700]);

		// Different stream that should be ignored
		db.run("INSERT INTO ZOBJECT VALUES (4, '/device/isLocked', NULL, ?, ?)", [startBase, startBase + 100]);
		db.close();

		const result = extractScreenTime(dbPath);
		expect(result.stats.error).toBeUndefined();
		expect(result.files.length).toBe(1);
		expect(result.files[0].path).toBe("screen_time/2024-08-10.txt");
		expect(result.files[0].content).toContain("Screen Time: 2024-08-10");
		expect(result.files[0].content).toContain("safari");
		expect(result.files[0].content).toContain("Slack");
		expect(result.files[0].content).toContain("2 sessions");
		expect(result.cursor.last_start_date).toBeDefined();
	});

	test("supports cursor-based incremental extraction", () => {
		const dbPath = path.join(tempDir, "knowledgeC.db");
		const db = new Database(dbPath);

		db.run("CREATE TABLE ZOBJECT (Z_PK INTEGER PRIMARY KEY, ZSTREAMNAME TEXT, ZVALUESTRING TEXT, ZSTARTDATE REAL, ZENDDATE REAL)");

		const s1 = cocoaTimestamp(new Date("2024-01-01T10:00:00Z"));
		const s2 = cocoaTimestamp(new Date("2024-01-02T10:00:00Z"));
		db.run("INSERT INTO ZOBJECT VALUES (1, '/app/usage', 'com.test.app', ?, ?)", [s1, s1 + 600]);
		db.run("INSERT INTO ZOBJECT VALUES (2, '/app/usage', 'com.test.app', ?, ?)", [s2, s2 + 600]);
		db.close();

		const first = extractScreenTime(dbPath);
		expect(first.files.length).toBe(2);

		const second = extractScreenTime(dbPath, first.cursor);
		expect(second.files).toHaveLength(0);
	});
});
