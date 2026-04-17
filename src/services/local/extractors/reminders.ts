import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
	cleanupTempCopy,
	cocoaToIso,
	copySqliteToTemp,
	openSqliteFromCopy,
} from "./shared.ts";

const QUERY_LIMIT = 50_000;

const PRIORITY_MAP: Record<number, string> = {
	1: "High",
	5: "Medium",
	9: "Low",
};

function safeName(name: string): string {
	return name.replace(/[^\w\-_ ]/g, "_").slice(0, 50);
}

interface ReminderRow {
	pk: number;
	title: string | null;
	notes: string | null;
	list_name: string | null;
	priority: number | null;
	completed: number;
	due_date: number | null;
	modified_at: number | null;
}

function findReminderDbs(basePath: string): string[] {
	// If basePath is a file, use it directly
	try {
		if (statSync(basePath).isFile()) return [basePath];
	} catch {
		return [];
	}

	const dbs: string[] = [];

	// Try Container_v1/Stores first (standard macOS path), then Stores, then basePath
	const storesDirs = [
		path.join(basePath, "Container_v1", "Stores"),
		path.join(basePath, "Stores"),
		basePath,
	];

	for (const storesDir of storesDirs) {
		let entries: string[];
		try {
			entries = readdirSync(storesDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const ext = path.extname(entry).toLowerCase();
			if ([".sqlite", ".sqlite3", ".db", ".storedata"].includes(ext)) {
				dbs.push(path.join(storesDir, entry));
			}
		}

		if (dbs.length > 0) break;
	}

	return dbs;
}

function hasTable(
	db: import("bun:sqlite").Database,
	tableName: string,
): boolean {
	const result = db
		.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
		.get(tableName) as { name: string } | null;
	return result !== null;
}

function extractFromSingleRemindersDb(
	dbPath: string,
	cursor: Record<string, unknown>,
	files: LocalFileItem[],
): { maxModifiedAt: number } {
	let copiedPath: string;
	try {
		copiedPath = copySqliteToTemp(dbPath, "reminders");
	} catch {
		return { maxModifiedAt: 0 };
	}

	let db: import("bun:sqlite").Database;
	try {
		db = openSqliteFromCopy(copiedPath);
	} catch {
		cleanupTempCopy(copiedPath);
		return { maxModifiedAt: 0 };
	}

	let maxModifiedAt = 0;
	try {
		if (!hasTable(db, "ZREMCDREMINDER")) {
			return { maxModifiedAt: 0 };
		}

		const cursorModified = (cursor.last_modified_at as number) ?? 0;
		const hasList = hasTable(db, "ZREMCDBASELIST");

		// Column names vary across macOS versions:
		// - ZTITLE vs ZTITLE1 for reminder title
		// - ZLASTMODIFIEDDATE vs ZMODIFICATIONDATE for modification time
		// - ZREMCDBASELIST vs ZREMCDCALENDAR for list table
		// - ZNAME vs ZTITLE for list name
		const reminderCols = new Set(
			(
				db.query("PRAGMA table_info(ZREMCDREMINDER)").all() as Array<{
					name: string;
				}>
			).map((c) => c.name.toUpperCase()),
		);
		const titleCol = reminderCols.has("ZTITLE1") ? "ZTITLE1" : "ZTITLE";
		const modCol = reminderCols.has("ZLASTMODIFIEDDATE")
			? "ZLASTMODIFIEDDATE"
			: reminderCols.has("ZMODIFICATIONDATE")
				? "ZMODIFICATIONDATE"
				: "ZMODIFIEDDATE";

		let listNameExpr = "NULL";
		if (hasList) {
			const listCols = new Set(
				(
					db.query("PRAGMA table_info(ZREMCDBASELIST)").all() as Array<{
						name: string;
					}>
				).map((c) => c.name.toUpperCase()),
			);
			const listNameCol = listCols.has("ZNAME")
				? "ZNAME"
				: listCols.has("ZTITLE")
					? "ZTITLE"
					: "ZTITLE1";
			listNameExpr = `c.${listNameCol}`;
		}

		const query = hasList
			? `SELECT
          r.Z_PK AS pk,
          r.${titleCol} AS title,
          r.ZNOTES AS notes,
          ${listNameExpr} AS list_name,
          r.ZPRIORITY AS priority,
          COALESCE(r.ZCOMPLETED, 0) AS completed,
          r.ZDUEDATE AS due_date,
          r.${modCol} AS modified_at
        FROM ZREMCDREMINDER r
        LEFT JOIN ZREMCDBASELIST c ON r.ZLIST = c.Z_PK
        WHERE r.${modCol} > ?
        ORDER BY r.${modCol}
        LIMIT ${QUERY_LIMIT}`
			: `SELECT
          r.Z_PK AS pk,
          r.${titleCol} AS title,
          r.ZNOTES AS notes,
          NULL AS list_name,
          r.ZPRIORITY AS priority,
          COALESCE(r.ZCOMPLETED, 0) AS completed,
          r.ZDUEDATE AS due_date,
          r.${modCol} AS modified_at
        FROM ZREMCDREMINDER r
        WHERE r.${modCol} > ?
        ORDER BY r.${modCol}
        LIMIT ${QUERY_LIMIT}`;

		const rows = db.query(query).all(cursorModified) as ReminderRow[];

		for (const row of rows) {
			const title = row.title ?? "Untitled";
			const list = row.list_name ?? "Reminders";

			const lines: string[] = [`Title: ${title}`];
			lines.push(`List: ${list}`);
			lines.push(`Status: ${row.completed ? "Completed" : "Pending"}`);

			if (row.priority && PRIORITY_MAP[row.priority]) {
				lines.push(`Priority: ${PRIORITY_MAP[row.priority]}`);
			}

			if (row.due_date) {
				lines.push(`Due: ${cocoaToIso(row.due_date) ?? "unknown"}`);
			}

			if (row.notes) {
				lines.push(`\nNotes:\n${row.notes}`);
			}

			files.push({
				path: `reminders/${safeName(list)}/${safeName(title)}_${row.pk}.txt`,
				content: lines.join("\n"),
				metadata: {
					source_type: "local_folder",
					source_subtype: "reminders",
					reminder_id: row.pk,
					list: list,
					completed: Boolean(row.completed),
					modified_at: cocoaToIso(row.modified_at),
				},
			});

			if ((row.modified_at ?? 0) > maxModifiedAt) {
				maxModifiedAt = row.modified_at ?? 0;
			}
		}
	} finally {
		try {
			db.close();
		} catch {}
		cleanupTempCopy(copiedPath);
	}

	return { maxModifiedAt };
}

export function extractReminders(
	dbPath: string,
	cursor: Record<string, unknown> = {},
): SyncExtractionResult {
	const dbPaths = findReminderDbs(dbPath);
	if (dbPaths.length === 0) {
		return {
			files: [],
			cursor: {},
			stats: { db_type: "reminders", error: "no Reminders databases found" },
		};
	}

	const files: LocalFileItem[] = [];
	let globalMaxModified = (cursor.last_modified_at as number) ?? 0;

	for (const singleDbPath of dbPaths) {
		const { maxModifiedAt } = extractFromSingleRemindersDb(
			singleDbPath,
			cursor,
			files,
		);
		if (maxModifiedAt > globalMaxModified) {
			globalMaxModified = maxModifiedAt;
		}
	}

	return {
		files,
		cursor: { last_modified_at: globalMaxModified },
		stats: {
			db_type: "reminders",
			extracted: files.length,
			db_count: dbPaths.length,
		},
	};
}
