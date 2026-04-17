import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
	cleanupTempCopy,
	copySqliteToTemp,
	openSqliteFromCopy,
} from "./shared.ts";

const QUERY_LIMIT = 50_000;
const APPLE_EPOCH_OFFSET = 978307200;

interface ScreenTimeRow {
	bundle_id: string;
	start_date: number;
	end_date: number;
}

interface AppDaySummary {
	bundle_id: string;
	session_count: number;
	total_seconds: number;
}

export function extractScreenTime(
	dbPath: string,
	cursor: Record<string, unknown> = {},
): SyncExtractionResult {
	let copiedPath: string;
	try {
		copiedPath = copySqliteToTemp(dbPath, "screentime");
	} catch (err) {
		return {
			files: [],
			cursor: {},
			stats: {
				db_type: "screentime",
				error: `copy failed: ${err instanceof Error ? err.message : String(err)}`,
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
				db_type: "screentime",
				error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}

	const files: LocalFileItem[] = [];
	let maxStartDate = (cursor.last_start_date as number) ?? 0;

	try {
		const cursorStart = (cursor.last_start_date as number) ?? 0;

		const rows = db
			.query(
				`SELECT
          ZVALUESTRING AS bundle_id,
          ZSTARTDATE AS start_date,
          ZENDDATE AS end_date
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND ZVALUESTRING IS NOT NULL
          AND ZSTARTDATE > ?
        ORDER BY ZSTARTDATE
        LIMIT ${QUERY_LIMIT}`,
			)
			.all(cursorStart) as ScreenTimeRow[];

		const dayGroups = new Map<string, ScreenTimeRow[]>();
		for (const row of rows) {
			const unixSec = row.start_date + APPLE_EPOCH_OFFSET;
			const dateStr = new Date(unixSec * 1000).toISOString().slice(0, 10);
			let group = dayGroups.get(dateStr);
			if (!group) {
				group = [];
				dayGroups.set(dateStr, group);
			}
			group.push(row);
		}

		for (const [dateStr, dayRows] of dayGroups) {
			const appMap = new Map<string, AppDaySummary>();

			for (const row of dayRows) {
				let summary = appMap.get(row.bundle_id);
				if (!summary) {
					summary = {
						bundle_id: row.bundle_id,
						session_count: 0,
						total_seconds: 0,
					};
					appMap.set(row.bundle_id, summary);
				}
				summary.session_count++;
				const duration = row.end_date - row.start_date;
				if (duration > 0) {
					summary.total_seconds += duration;
				}
			}

			const sortedApps = Array.from(appMap.values()).sort(
				(a, b) => b.total_seconds - a.total_seconds,
			);

			const totalMinutes =
				sortedApps.reduce((sum, a) => sum + a.total_seconds, 0) / 60;

			const lines: string[] = [
				`Screen Time: ${dateStr}`,
				`Total: ${Math.round(totalMinutes)} minutes across ${sortedApps.length} apps`,
				"",
			];

			for (const app of sortedApps) {
				const mins = Math.round(app.total_seconds / 60);
				const appName = app.bundle_id.split(".").pop() ?? app.bundle_id;
				lines.push(
					`${appName} (${app.bundle_id}): ${mins}m, ${app.session_count} session${app.session_count === 1 ? "" : "s"}`,
				);
			}

			files.push({
				path: `screen_time/${dateStr}.txt`,
				content: lines.join("\n"),
				metadata: {
					source_type: "local_folder",
					source_subtype: "screentime",
					date: dateStr,
					app_count: sortedApps.length,
					total_minutes: Math.round(totalMinutes),
				},
			});
		}

		if (rows.length > 0) {
			maxStartDate = (rows[rows.length - 1] as ScreenTimeRow).start_date;
		}
	} finally {
		try {
			db.close();
		} catch {}
		cleanupTempCopy(copiedPath);
	}

	return {
		files,
		cursor: { last_start_date: maxStartDate },
		stats: { db_type: "screentime", extracted: files.length },
	};
}
