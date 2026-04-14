import {
	copyFileSync,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_DIR = path.join(tmpdir(), "nia-personal-sqlite");

const APPLE_EPOCH_OFFSET = 978307200;

export function cocoaToIso(
	cocoaTimestamp: number | null | undefined,
): string | null {
	if (cocoaTimestamp == null || Number.isNaN(cocoaTimestamp)) return null;
	const unixMs = (cocoaTimestamp + APPLE_EPOCH_OFFSET) * 1000;
	const d = new Date(unixMs);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function copySqliteToTemp(dbPath: string, connectorKey: string): string {
	try {
		mkdirSync(TEMP_DIR, { recursive: true });
	} catch {
		// best effort
	}

	const stat = statSync(dbPath);
	const baseName = path.basename(dbPath);
	const copiedPath = path.join(
		TEMP_DIR,
		`${connectorKey}-${stat.mtimeMs.toFixed(0)}-${baseName}`,
	);

	// Always re-copy: WAL state changes without updating main file mtime.
	copyFileSync(dbPath, copiedPath);

	// Copy WAL and SHM companions if they exist.
	for (const suffix of ["-wal", "-shm"]) {
		const companion = dbPath + suffix;
		if (existsSync(companion)) {
			try {
				copyFileSync(companion, copiedPath + suffix);
			} catch {
				// WAL copy is best-effort
			}
		}
	}

	return copiedPath;
}

export function openSqliteFromCopy(
	copiedPath: string,
): import("bun:sqlite").Database {
	const { Database } = require("bun:sqlite") as {
		Database: typeof import("bun:sqlite").Database;
	};
	// Do NOT use readonly: true. The temp copy is safe to write to, and
	// readonly mode fails on WAL-mode databases when the WAL file is
	// missing or incomplete (SQLITE_CANTOPEN).
	return new Database(copiedPath);
}

export function cleanupTempCopy(copiedPath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			unlinkSync(copiedPath + suffix);
		} catch {
			// ignore
		}
	}
}
