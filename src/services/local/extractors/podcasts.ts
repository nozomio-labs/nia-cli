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

function stripHtml(html: string | null): string | null {
	if (!html) return null;
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatDuration(seconds: number | null): string | null {
	if (seconds == null || seconds <= 0) return null;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m ${s}s`;
}

interface PodcastRow {
	episode_pk: number;
	episode_title: string | null;
	show_title: string | null;
	description: string | null;
	author: string | null;
	pub_date: number | null;
	duration: number | null;
	play_count: number | null;
}

export function extractPodcasts(
	dbPath: string,
	cursor: Record<string, unknown> = {},
): SyncExtractionResult {
	let copiedPath: string;
	try {
		copiedPath = copySqliteToTemp(dbPath, "podcasts");
	} catch (err) {
		return {
			files: [],
			cursor: {},
			stats: {
				db_type: "podcasts",
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
				db_type: "podcasts",
				error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}

	const files: LocalFileItem[] = [];
	let maxPubDate = (cursor.last_pub_date as number) ?? 0;
	let maxEpisodePk = (cursor.last_episode_pk as number) ?? 0;

	try {
		const cursorPubDate = (cursor.last_pub_date as number) ?? 0;
		const cursorPk = (cursor.last_episode_pk as number) ?? 0;

		const rows = db
			.query(
				`SELECT
          e.Z_PK AS episode_pk,
          e.ZTITLE AS episode_title,
          p.ZTITLE AS show_title,
          e.ZASSETDESCRIPTION AS description,
          p.ZAUTHOR AS author,
          e.ZPUBDATE AS pub_date,
          e.ZDURATION AS duration,
          e.ZPLAYCOUNT AS play_count
        FROM MTEPISODE e
        LEFT JOIN MTPODCAST p ON e.ZPODCAST = p.Z_PK
        WHERE (e.ZPUBDATE > ? OR (e.ZPUBDATE = ? AND e.Z_PK > ?))
        ORDER BY e.ZPUBDATE, e.Z_PK
        LIMIT ${QUERY_LIMIT}`,
			)
			.all(cursorPubDate, cursorPubDate, cursorPk) as PodcastRow[];

		for (const row of rows) {
			const title = row.episode_title ?? "Untitled Episode";
			const show = row.show_title ?? "Unknown Podcast";
			const pubIso = cocoaToIso(row.pub_date);
			const dateStr = (pubIso ?? "unknown").slice(0, 10);

			const lines: string[] = [`Episode: ${title}`, `Show: ${show}`];
			if (row.author) lines.push(`Author: ${row.author}`);
			lines.push(`Published: ${pubIso ?? "unknown"}`);

			const duration = formatDuration(row.duration);
			if (duration) lines.push(`Duration: ${duration}`);
			if (row.play_count) lines.push(`Play count: ${row.play_count}`);

			const description = stripHtml(row.description);
			if (description) {
				lines.push(`\nDescription:\n${description}`);
			}

			const filePath = `podcasts/${safeName(show)}/${dateStr}_${safeName(title)}_${row.episode_pk}.txt`;

			files.push({
				path: filePath,
				content: lines.join("\n"),
				metadata: {
					source_type: "local_folder",
					source_subtype: "podcasts",
					episode_id: row.episode_pk,
					show: show,
					pub_date: pubIso,
				},
			});

			if (
				(row.pub_date ?? 0) > maxPubDate ||
				((row.pub_date ?? 0) === maxPubDate && row.episode_pk > maxEpisodePk)
			) {
				maxPubDate = row.pub_date ?? 0;
				maxEpisodePk = row.episode_pk;
			}
		}
	} finally {
		try {
			db.close();
		} catch {}
		cleanupTempCopy(copiedPath);
	}

	return {
		files,
		cursor: {
			last_pub_date: maxPubDate,
			last_episode_pk: maxEpisodePk,
		},
		stats: { db_type: "podcasts", extracted: files.length },
	};
}
