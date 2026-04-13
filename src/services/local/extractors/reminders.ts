import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
  copySqliteToTemp,
  openSqliteFromCopy,
  cleanupTempCopy,
  cocoaToIso,
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
  const dbs: string[] = [];

  const storesDir = path.join(basePath, "Stores");
  let entries: string[];
  try {
    entries = readdirSync(storesDir);
  } catch {
    try {
      statSync(basePath);
      return [basePath];
    } catch {
      return [];
    }
  }

  for (const entry of entries) {
    const storePath = path.join(storesDir, entry);
    try {
      if (statSync(storePath).isDirectory()) {
        const innerEntries = readdirSync(storePath);
        for (const inner of innerEntries) {
          const ext = path.extname(inner).toLowerCase();
          if ([".sqlite", ".db", ".storedata"].includes(ext)) {
            dbs.push(path.join(storePath, inner));
          }
        }
      }
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

function hasTable(db: import("bun:sqlite").Database, tableName: string): boolean {
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
    const hasCalendar = hasTable(db, "ZREMCDCALENDAR");

    const query = hasCalendar
      ? `SELECT
          r.Z_PK AS pk,
          r.ZTITLE1 AS title,
          r.ZNOTES AS notes,
          c.ZTITLE1 AS list_name,
          r.ZPRIORITY AS priority,
          COALESCE(r.ZCOMPLETED, 0) AS completed,
          r.ZDUEDATE AS due_date,
          r.ZMODIFIEDDATE AS modified_at
        FROM ZREMCDREMINDER r
        LEFT JOIN ZREMCDCALENDAR c ON r.ZLIST = c.Z_PK
        WHERE r.ZMODIFIEDDATE > ?
        ORDER BY r.ZMODIFIEDDATE
        LIMIT ${QUERY_LIMIT}`
      : `SELECT
          r.Z_PK AS pk,
          r.ZTITLE1 AS title,
          r.ZNOTES AS notes,
          NULL AS list_name,
          r.ZPRIORITY AS priority,
          COALESCE(r.ZCOMPLETED, 0) AS completed,
          r.ZDUEDATE AS due_date,
          r.ZMODIFIEDDATE AS modified_at
        FROM ZREMCDREMINDER r
        WHERE r.ZMODIFIEDDATE > ?
        ORDER BY r.ZMODIFIEDDATE
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
    const { maxModifiedAt } = extractFromSingleRemindersDb(singleDbPath, cursor, files);
    if (maxModifiedAt > globalMaxModified) {
      globalMaxModified = maxModifiedAt;
    }
  }

  return {
    files,
    cursor: { last_modified_at: globalMaxModified },
    stats: { db_type: "reminders", extracted: files.length, db_count: dbPaths.length },
  };
}
