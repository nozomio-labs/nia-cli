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

function safeName(name: string): string {
	return name.replace(/[^\w\-_ ]/g, "_").slice(0, 50);
}

interface ContactRow {
	pk: number;
	first_name: string | null;
	last_name: string | null;
	organization: string | null;
	job_title: string | null;
	note: string | null;
	modified_at: number | null;
	phones: string | null;
	emails: string | null;
}

function findAddressBookDbs(basePath: string): string[] {
	const dbs: string[] = [];

	const sourcesDir = path.join(basePath, "Sources");
	let entries: string[];
	try {
		entries = readdirSync(sourcesDir);
	} catch {
		const mainDb = path.join(basePath, "AddressBook-v22.abcddb");
		try {
			statSync(mainDb);
			return [mainDb];
		} catch {
			return [basePath];
		}
	}

	for (const entry of entries) {
		const dbPath = path.join(sourcesDir, entry, "AddressBook-v22.abcddb");
		try {
			statSync(dbPath);
			dbs.push(dbPath);
		} catch {}
	}

	if (dbs.length === 0) {
		try {
			statSync(basePath);
			dbs.push(basePath);
		} catch {}
	}

	return dbs;
}

function extractFromSingleContactsDb(
	dbPath: string,
	cursor: Record<string, unknown>,
	files: LocalFileItem[],
): { maxModifiedAt: number } {
	let copiedPath: string;
	try {
		copiedPath = copySqliteToTemp(dbPath, "contacts");
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
		const cursorModified = (cursor.last_modified_at as number) ?? 0;

		const rows = db
			.query(
				`SELECT
          r.Z_PK AS pk,
          r.ZFIRSTNAME AS first_name,
          r.ZLASTNAME AS last_name,
          r.ZORGANIZATION AS organization,
          r.ZJOBTITLE AS job_title,
          r.ZNOTE AS note,
          r.ZMODIFICATIONDATE AS modified_at,
          GROUP_CONCAT(DISTINCT ph.ZFULLNUMBER) AS phones,
          GROUP_CONCAT(DISTINCT em.ZADDRESS) AS emails
        FROM ZABCDRECORD r
        LEFT JOIN ZABCDPHONENUMBER ph ON ph.ZOWNER = r.Z_PK
        LEFT JOIN ZABCDEMAILADDRESS em ON em.ZOWNER = r.Z_PK
        WHERE r.ZMODIFICATIONDATE > ?
        GROUP BY r.Z_PK
        ORDER BY r.ZMODIFICATIONDATE
        LIMIT ${QUERY_LIMIT}`,
			)
			.all(cursorModified) as ContactRow[];

		for (const row of rows) {
			const nameParts = [row.first_name, row.last_name].filter(Boolean);
			const displayName =
				nameParts.length > 0
					? nameParts.join(" ")
					: (row.organization ?? "Unknown");

			const lines: string[] = [`Name: ${displayName}`];
			if (row.organization) lines.push(`Organization: ${row.organization}`);
			if (row.job_title) lines.push(`Title: ${row.job_title}`);
			if (row.phones) lines.push(`Phone: ${row.phones.split(",").join(", ")}`);
			if (row.emails) lines.push(`Email: ${row.emails.split(",").join(", ")}`);
			if (row.note) lines.push(`\nNotes:\n${row.note}`);

			files.push({
				path: `contacts/${safeName(displayName)}_${row.pk}.txt`,
				content: lines.join("\n"),
				metadata: {
					source_type: "local_folder",
					source_subtype: "contacts",
					contact_id: row.pk,
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

export function extractContacts(
	dbPath: string,
	cursor: Record<string, unknown> = {},
): SyncExtractionResult {
	const dbPaths = findAddressBookDbs(dbPath);
	if (dbPaths.length === 0) {
		return {
			files: [],
			cursor: {},
			stats: { db_type: "contacts", error: "no AddressBook databases found" },
		};
	}

	const files: LocalFileItem[] = [];
	let globalMaxModified = (cursor.last_modified_at as number) ?? 0;

	for (const singleDbPath of dbPaths) {
		const { maxModifiedAt } = extractFromSingleContactsDb(
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
			db_type: "contacts",
			extracted: files.length,
			db_count: dbPaths.length,
		},
	};
}
