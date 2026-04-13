import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
	FolderCursor,
	LocalFileItem,
	SyncExtractionResult,
} from "./types.ts";
import { copySqliteToTemp, openSqliteFromCopy, cleanupTempCopy } from "./extractors/shared.ts";
import { extractWhatsApp } from "./extractors/whatsapp.ts";
import { extractNotes } from "./extractors/notes.ts";
import { extractContacts } from "./extractors/contacts.ts";
import { extractReminders } from "./extractors/reminders.ts";
import { extractPodcasts } from "./extractors/podcasts.ts";
import { extractPhotos } from "./extractors/photos.ts";
import { extractScreenTime } from "./extractors/screentime.ts";

export const TYPE_FOLDER = "folder";
export const MAX_ROWS = 100_000;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const FOLDER_CURSOR_VERSION = 1;

export const SKIP_DIRS = new Set([
	".git",
	".svn",
	".hg",
	".bzr",
	"node_modules",
	".npm",
	".pnpm-store",
	".yarn",
	"bower_components",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".parcel-cache",
	".cache",
	".turbo",
	"__pycache__",
	"venv",
	".venv",
	"env",
	".tox",
	".nox",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".hypothesis",
	"htmlcov",
	".Python",
	"target",
	".gradle",
	".m2",
	"vendor",
	".bundle",
	"bin",
	"obj",
	"packages",
	"DerivedData",
	"Pods",
	".build",
	"dist",
	"build",
	"out",
	"output",
	"release",
	"debug",
	"coverage",
	".nyc_output",
	".idea",
	".vscode",
	".atom",
	".Spotlight-V100",
	".Trashes",
	".terraform",
	".vagrant",
	".docker",
	".kube",
	"logs",
	"log",
	"tmp",
	"temp",
	".aws",
	".ssh",
]);

export const SKIP_EXTENSIONS = new Set([
	".pem",
	".key",
	".p12",
	".pfx",
	".crt",
	".cer",
	".asc",
	".pyc",
	".pyo",
	".pyd",
	".egg",
	".class",
	".jar",
	".war",
	".ear",
	".exe",
	".pdb",
	".nupkg",
	".so",
	".dylib",
	".dll",
	".o",
	".obj",
	".a",
	".lib",
	".wasm",
	".sqlite",
	".sqlite3",
	".db",
	".sql",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".ico",
	".webp",
	".bmp",
	".tiff",
	".tif",
	".psd",
	".ai",
	".sketch",
	".fig",
	".mp4",
	".avi",
	".mov",
	".wmv",
	".webm",
	".mkv",
	".flv",
	".mp3",
	".wav",
	".ogg",
	".flac",
	".aac",
	".m4a",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".zip",
	".tar",
	".gz",
	".tgz",
	".rar",
	".7z",
	".bz2",
	".xz",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".log",
	".tmp",
	".temp",
	".bak",
	".backup",
	".old",
	".swp",
	".swo",
	".lcov",
	".code-workspace",
]);

export const SKIP_FILES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"poetry.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"composer.lock",
	"Cargo.lock",
	"gradle.lockfile",
	"Package.resolved",
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	"ehthumbs.db",
	".env",
	".envrc",
	".npmrc",
	".pypirc",
	".netrc",
	".htpasswd",
	"npm-debug.log",
	"yarn-debug.log",
	"yarn-error.log",
	".pnpm-debug.log",
	"pip-log.txt",
	".project",
	".classpath",
	".coverage",
]);

export const SKIP_PATH_PATTERNS = [
	"credentials",
	"secrets",
	".secret",
	".secrets",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
];

export const SKIP_FILENAME_PATTERNS = [
	"openpgp",
	"pgp_key",
	"gpg_key",
	"pubkey",
	"privkey",
	"public_key",
	"private_key",
	"signing_key",
	"0x",
];

export const ALLOWED_EXTENSIONLESS_FILES = new Set([
	"makefile",
	"dockerfile",
	"vagrantfile",
	"procfile",
	"gemfile",
	"rakefile",
	"guardfile",
	"brewfile",
	"berksfile",
	"thorfile",
	"capfile",
	"podfile",
	"fastfile",
	"appfile",
	"matchfile",
	"snapfile",
	"scanfile",
	"gymfile",
	"deliverfile",
	"pluginfile",
	"cmakelists.txt",
	"justfile",
	"taskfile",
	"earthfile",
	"readme",
	"changelog",
	"license",
	"licence",
	"authors",
	"contributing",
	"copying",
	"todo",
	"news",
	"history",
]);

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".py",
	".js",
	".ts",
	".tsx",
	".jsx",
	".json",
	".yaml",
	".yml",
	".html",
	".css",
	".scss",
	".less",
	".xml",
	".csv",
	".sh",
	".bash",
	".zsh",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".rb",
	".vue",
	".svelte",
	".php",
	".swift",
	".kt",
	".scala",
	".r",
	".sql",
	".toml",
	".ini",
	".cfg",
	".makefile",
	".dockerfile",
	".gitignore",
	".editorconfig",
]);

export function normalizeFolderCursor(
	folderPath: string,
	cursor?: Record<string, unknown> | null,
): { cursor: FolderCursor; resetReason?: string } {
	if (!cursor) {
		return { cursor: {}, resetReason: "missing" };
	}

	const typedCursor = cursor as FolderCursor;
	const normalizedRoot = typedCursor.root_path
		? path.resolve(typedCursor.root_path)
		: undefined;
	const normalizedFolder = path.resolve(folderPath);

	if (typedCursor.cursor_version !== FOLDER_CURSOR_VERSION) {
		return { cursor: {}, resetReason: "version_mismatch" };
	}
	if (!normalizedRoot) {
		return { cursor: {}, resetReason: "missing_root_path" };
	}
	if (normalizedRoot !== normalizedFolder) {
		return { cursor: {}, resetReason: "root_path_changed" };
	}

	return {
		cursor: {
			last_mtime: typedCursor.last_mtime,
			last_path: typedCursor.last_path,
			cursor_version: typedCursor.cursor_version,
			root_path: normalizedRoot,
		},
	};
}

function isLikelyBinary(content: Uint8Array): boolean {
	if (content.length === 0) {
		return false;
	}
	for (const byte of content) {
		if (byte === 0) {
			return true;
		}
	}
	let nonText = 0;
	for (const byte of content) {
		if (byte < 8 || (byte >= 14 && byte < 32)) {
			nonText += 1;
		}
	}
	return nonText / content.length > 0.1;
}

function shouldSkipFile(filename: string): { skip: boolean; reason?: string } {
	if (SKIP_FILES.has(filename) || filename.startsWith(".")) {
		return { skip: true };
	}

	const filenameLower = filename.toLowerCase();
	if (SKIP_PATH_PATTERNS.some((pattern) => filenameLower.includes(pattern))) {
		return { skip: true, reason: "security_pattern" };
	}
	if (
		SKIP_FILENAME_PATTERNS.some((pattern) => filenameLower.includes(pattern))
	) {
		return { skip: true, reason: "filename_pattern" };
	}

	const extension = path.extname(filenameLower);
	if (extension && SKIP_EXTENSIONS.has(extension)) {
		return { skip: true, reason: "extension" };
	}
	if (!extension && !ALLOWED_EXTENSIONLESS_FILES.has(filenameLower)) {
		return { skip: true, reason: "no_extension" };
	}
	if (extension && !TEXT_EXTENSIONS.has(extension)) {
		return { skip: true, reason: "extension" };
	}

	return { skip: false };
}

function walkFolder(
	rootPath: string,
	currentPath: string,
	files: LocalFileItem[],
	cursor: FolderCursor,
	maxState: { mtime: number; relativePath: string },
	skippedCounts: Record<string, number>,
	limit: number,
): void {
	if (files.length >= limit) {
		return;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(currentPath, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	} catch {
		skippedCounts.permission_denied =
			(skippedCounts.permission_denied ?? 0) + 1;
		return;
	}

	for (const entry of entries) {
		if (files.length >= limit) {
			return;
		}

		const absolutePath = path.join(currentPath, entry.name);
		const relativePath = path.relative(rootPath, absolutePath);

		if (entry.isDirectory()) {
			if (
				SKIP_DIRS.has(entry.name) ||
				entry.name.startsWith(".") ||
				entry.name.endsWith(".egg-info")
			) {
				continue;
			}
			walkFolder(
				rootPath,
				absolutePath,
				files,
				cursor,
				maxState,
				skippedCounts,
				limit,
			);
			continue;
		}

		const skip = shouldSkipFile(entry.name);
		if (skip.skip) {
			if (skip.reason) {
				skippedCounts[skip.reason] = (skippedCounts[skip.reason] ?? 0) + 1;
			}
			continue;
		}

		try {
			const stat = statSync(absolutePath);
			const mtime = stat.mtimeMs / 1000;

			if ((cursor.last_mtime ?? 0) > mtime) {
				continue;
			}
			if (
				(cursor.last_mtime ?? 0) === mtime &&
				relativePath <= (cursor.last_path ?? "")
			) {
				continue;
			}

			if (stat.size > MAX_FILE_SIZE_BYTES) {
				skippedCounts.too_large = (skippedCounts.too_large ?? 0) + 1;
				continue;
			}

			const sample = readFileSync(absolutePath).subarray(0, 8192);
			if (isLikelyBinary(sample)) {
				skippedCounts.binary = (skippedCounts.binary ?? 0) + 1;
				continue;
			}

			const content = readFileSync(absolutePath, "utf8");
			if (!content.trim()) {
				continue;
			}

			files.push({
				path: relativePath,
				content,
				metadata: {
					db_type: TYPE_FOLDER,
					extension: path.extname(entry.name).toLowerCase(),
					mtime,
				},
			});

			if (
				mtime > maxState.mtime ||
				(mtime === maxState.mtime && relativePath > maxState.relativePath)
			) {
				maxState.mtime = mtime;
				maxState.relativePath = relativePath;
			}
		} catch {}
	}
}

// ---------------------------------------------------------------------------
// Generic SQLite extraction
//
// Mirrors what the backend's `extract_generic` does (db_extractor.py:1358) but
// runs client-side. Walks all tables in any SQLite file, finds TEXT columns,
// emits one virtual file per row. Used for personal-data sources where we
// don't have (or don't need) a dedicated extractor: Apple Notes, Reminders,
// Contacts, Books, Podcasts, Anki, Day One, Bear, Things, OmniFocus,
// Photos.sqlite, knowledgeC.db (Screen Time), Significant Locations, etc.
//
// Uses Bun's built-in `bun:sqlite` (no extra dependencies). Opens the file
// read-only and copies it to a temp location first to avoid lock contention
// when the source app is running (Chrome holds History.db open, etc.).
//
// Some macOS personal-data sources sit at directory paths that contain a
// nested SQLite (e.g. Reminders, Contacts, Books library). The extractor
// also accepts a directory path and recursively finds the first .sqlite /
// .db / .abcddb file inside.
// ---------------------------------------------------------------------------

const SQLITE_MAX_ROWS_PER_TABLE = 5_000;
const SQLITE_MAX_TOTAL_ROWS = 50_000;

// Internal SQLite tables to skip (FTS index shadow tables, etc.)
const SQLITE_SKIP_TABLE_PATTERNS = [
	/^sqlite_/, // sqlite_master, sqlite_sequence, sqlite_stat*
	/_fts_/, // FTS shadow tables
	/_fts$/,
	/_idx$/,
	/_data$/,
	/_config$/,
	/_docsize$/,
	/_segdir$/,
	/_segments$/,
];

const SQLITE_FILE_EXTENSIONS = [
	".sqlite",
	".sqlite3",
	".db",
	".abcddb", // Apple AddressBook
	".storedata", // CoreData
];

function findSqliteInDir(dir: string, maxDepth = 4): string | null {
	if (maxDepth < 0) return null;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	// Files first
	for (const name of entries) {
		const full = path.join(dir, name);
		try {
			const st = statSync(full);
			if (st.isFile()) {
				const ext = path.extname(name).toLowerCase();
				if (SQLITE_FILE_EXTENSIONS.includes(ext)) return full;
			}
		} catch {
			// skip
		}
	}
	// Then recurse
	for (const name of entries) {
		const full = path.join(dir, name);
		try {
			const st = statSync(full);
			if (st.isDirectory() && !SKIP_DIRS.has(name)) {
				const found = findSqliteInDir(full, maxDepth - 1);
				if (found) return found;
			}
		} catch {
			// skip
		}
	}
	return null;
}

function safeTableName(name: string): string {
	return name.replace(/[^\w\-_]/g, "_");
}

function shouldSkipTable(name: string): boolean {
	for (const pattern of SQLITE_SKIP_TABLE_PATTERNS) {
		if (pattern.test(name)) return true;
	}
	return false;
}

export interface SqliteExtractionOptions {
	maxRowsPerTable?: number;
	maxTotalRows?: number;
}

export function extractSqliteSource(
	sourcePath: string,
	connectorKey: string,
	options: SqliteExtractionOptions = {},
): SyncExtractionResult {
	const maxRowsPerTable = options.maxRowsPerTable ?? SQLITE_MAX_ROWS_PER_TABLE;
	const maxTotalRows = options.maxTotalRows ?? SQLITE_MAX_TOTAL_ROWS;

	// Resolve to an actual SQLite file. Some sources point at a directory
	// (Apple Reminders, Contacts, Books library, etc.) — walk for the first
	// .sqlite / .db / .abcddb / .storedata.
	let dbPath = path.resolve(sourcePath);
	let isDir = false;
	try {
		isDir = statSync(dbPath).isDirectory();
	} catch {
		// not found — return empty
		return {
			files: [],
			cursor: {},
			stats: {
				db_type: connectorKey,
				skipped: 0,
				error: `path does not exist: ${sourcePath}`,
			},
		};
	}
	if (isDir) {
		const found = findSqliteInDir(dbPath);
		if (!found) {
			return {
				files: [],
				cursor: {},
				stats: {
					db_type: connectorKey,
					skipped: 0,
					error: `no SQLite file found under ${sourcePath} (searched 4 levels deep for .sqlite / .db / .abcddb / .storedata)`,
				},
			};
		}
		dbPath = found;
	}

	const typedExtractors: Record<string, (p: string, c?: Record<string, unknown>) => SyncExtractionResult> = {
		whatsapp: extractWhatsApp,
		notes: extractNotes,
		contacts: extractContacts,
		reminders: extractReminders,
		podcasts: extractPodcasts,
		photos_metadata: extractPhotos,
		screen_time: extractScreenTime,
	};

	const typedExtractor = typedExtractors[connectorKey];
	if (typedExtractor) {
		return typedExtractor(dbPath);
	}

	let copiedPath: string;
	try {
		copiedPath = copySqliteToTemp(dbPath, connectorKey);
	} catch (err) {
		return {
			files: [],
			cursor: {},
			stats: {
				db_type: connectorKey,
				error: `failed to copy SQLite file: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}

	let db: import("bun:sqlite").Database;
	try {
		db = openSqliteFromCopy(copiedPath);
	} catch (err) {
		cleanupTempCopy(copiedPath);
		return {
			files: [],
			cursor: {},
			stats: {
				db_type: connectorKey,
				error: `failed to open SQLite: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}

	const files: LocalFileItem[] = [];
	let totalExtracted = 0;
	let tablesScanned = 0;
	let tablesSkipped = 0;

	try {
		// List all tables.
		const tableRows = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>;

		for (const { name: tableName } of tableRows) {
			if (totalExtracted >= maxTotalRows) break;
			if (shouldSkipTable(tableName)) {
				tablesSkipped++;
				continue;
			}
			tablesScanned++;

			// Discover columns.
			let columns: Array<{ cid: number; name: string; type: string }>;
			try {
				columns = db
					.query(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
					.all() as Array<{ cid: number; name: string; type: string }>;
			} catch {
				continue;
			}
			if (columns.length === 0) continue;

			// Find TEXT-ish columns (TEXT, VARCHAR, CHAR, CLOB, NVARCHAR, etc.)
			const textCols = columns
				.filter((c) => {
					const t = (c.type || "").toUpperCase();
					return (
						t.includes("TEXT") ||
						t.includes("CHAR") ||
						t.includes("CLOB") ||
						t === ""
					);
				})
				.map((c) => c.name);
			if (textCols.length === 0) continue;

			// Pick a primary key column for row identification (or rowid fallback).
			const pkCol =
				columns.find((c) => (c as { pk?: number }).pk === 1)?.name ?? "rowid";

			const remaining = maxTotalRows - totalExtracted;
			const limit = Math.min(remaining, maxRowsPerTable);

			const selectCols = [
				`"${pkCol.replace(/"/g, '""')}" AS __nia_pk`,
				...textCols.map((c) => `"${c.replace(/"/g, '""')}" AS "${c}"`),
			].join(", ");

			let rows: Array<Record<string, unknown>>;
			try {
				rows = db
					.query(
						`SELECT ${selectCols} FROM "${tableName.replace(/"/g, '""')}" LIMIT ${limit}`,
					)
					.all() as Array<Record<string, unknown>>;
			} catch {
				continue;
			}

			for (const row of rows) {
				const pkValue = row.__nia_pk;
				const parts: string[] = [];
				for (const col of textCols) {
					const v = row[col];
					if (typeof v === "string" && v.trim().length > 0) {
						parts.push(`${col}: ${v}`);
					}
				}
				if (parts.length === 0) continue;
				const content = parts.join("\n");

				const safeTable = safeTableName(tableName);
				files.push({
					path: `${safeTable}/row_${String(pkValue ?? totalExtracted)}.txt`,
					content,
					metadata: {
						source_type: "local_folder",
						source_subtype: "database",
						db_type: connectorKey,
						table: tableName,
						row_id: pkValue,
					},
				});
				totalExtracted++;
				if (totalExtracted >= maxTotalRows) break;
			}
		}
	} finally {
		try {
			db.close();
		} catch {
			// ignore
		}
		cleanupTempCopy(copiedPath);
	}

	return {
		files,
		cursor: {},
		stats: {
			db_type: connectorKey,
			extracted: totalExtracted,
			tables_scanned: tablesScanned,
			tables_skipped: tablesSkipped,
			source_path: dbPath,
		},
	};
}

export function extractFolderIncremental(
	folderPath: string,
	cursor: FolderCursor = {},
	limit = MAX_ROWS,
): SyncExtractionResult {
	const normalizedPath = path.resolve(folderPath);
	const files: LocalFileItem[] = [];
	const skippedCounts: Record<string, number> = {
		extension: 0,
		no_extension: 0,
		binary: 0,
		too_large: 0,
		security_pattern: 0,
		filename_pattern: 0,
	};

	const maxState = {
		mtime: cursor.last_mtime ?? 0,
		relativePath: cursor.last_path ?? "",
	};

	walkFolder(
		normalizedPath,
		normalizedPath,
		files,
		cursor,
		maxState,
		skippedCounts,
		limit,
	);

	const totalSkipped = Object.values(skippedCounts).reduce(
		(total, count) => total + count,
		0,
	);

	return {
		files,
		cursor: {
			last_mtime: maxState.mtime,
			last_path: maxState.relativePath,
			cursor_version: FOLDER_CURSOR_VERSION,
			root_path: normalizedPath,
		},
		stats: {
			extracted: files.length,
			db_type: TYPE_FOLDER,
			skipped: totalSkipped,
			skip_details: Object.fromEntries(
				Object.entries(skippedCounts).filter(([, count]) => count > 0),
			),
		},
	};
}
