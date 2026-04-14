import { gunzipSync } from "node:zlib";
import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
  copySqliteToTemp,
  openSqliteFromCopy,
  cleanupTempCopy,
  cocoaToIso,
} from "./shared.ts";

const QUERY_LIMIT = 50_000;

function safeName(name: string): string {
  return name.replace(/[^\w\-_ ]/g, "_").slice(0, 50);
}

function extractTextFromNoteBody(blob: Buffer | Uint8Array | null): string | null {
  if (!blob || blob.length === 0) return null;

  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(Buffer.from(blob));
  } catch {
    return null;
  }

  const chunks: string[] = [];
  let i = 0;
  const bytes = decompressed;

  while (i < bytes.length) {
    if (bytes[i] >= 0x20 && bytes[i] < 0x7f) {
      let end = i;
      while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] < 0x7f) {
        end++;
      }
      const fragment = bytes.subarray(i, end).toString();
      if (fragment.length >= 2 && !isProtobufArtifact(fragment)) {
        chunks.push(fragment);
      }
      i = end;
    } else if (bytes[i] >= 0xc0) {
      let end = i;
      while (end < bytes.length && (bytes[end] >= 0x80 || (bytes[end] >= 0x20 && bytes[end] < 0x7f))) {
        end++;
      }
      try {
        const fragment = Buffer.from(bytes.subarray(i, end)).toString("utf8");
        if (fragment.length >= 2 && !isProtobufArtifact(fragment)) {
          chunks.push(fragment);
        }
      } catch {}
      i = end;
    } else {
      i++;
    }
  }

  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : null;
}

function isProtobufArtifact(s: string): boolean {
  const lower = s.toLowerCase();
  return (
    lower.includes("nsfont") ||
    lower.includes("nscolor") ||
    lower.includes("nsattributedstring") ||
    lower.includes("nsmutableparagraphstyle") ||
    lower.includes("com.apple.") ||
    lower.startsWith("\\") ||
    /^[\x00-\x1f]+$/.test(s)
  );
}

interface NoteRow {
  note_id: number;
  title: string | null;
  folder_name: string | null;
  modified_at: number | null;
  body_data: Buffer | null;
  is_password_protected: number;
  is_trashed: number;
}

export function extractNotes(
  dbPath: string,
  cursor: Record<string, unknown> = {},
): SyncExtractionResult {
  let copiedPath: string;
  try {
    copiedPath = copySqliteToTemp(dbPath, "notes");
  } catch (err) {
    return {
      files: [],
      cursor: {},
      stats: {
        db_type: "notes",
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
        db_type: "notes",
        error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const files: LocalFileItem[] = [];
  let maxNoteId = (cursor.last_note_id as number) ?? 0;
  let maxModifiedAt = (cursor.last_modified_at as number) ?? 0;

  try {
    const cursorModified = (cursor.last_modified_at as number) ?? 0;
    const cursorNoteId = (cursor.last_note_id as number) ?? 0;

    const rows = db
      .query(
        `SELECT
          n.Z_PK AS note_id,
          n.ZTITLE1 AS title,
          folder.ZTITLE2 AS folder_name,
          n.ZMODIFICATIONDATE1 AS modified_at,
          nd.ZDATA AS body_data,
          COALESCE(n.ZISPASSWORDPROTECTED, 0) AS is_password_protected,
          COALESCE(n.ZMARKEDFORDELETION, 0) AS is_trashed
        FROM ZICCLOUDSYNCINGOBJECT n
        LEFT JOIN ZICNOTEDATA nd ON n.Z_PK = nd.ZNOTE
        LEFT JOIN ZICCLOUDSYNCINGOBJECT folder ON n.ZFOLDER = folder.Z_PK
        WHERE n.ZTITLE1 IS NOT NULL
          AND COALESCE(n.ZISPASSWORDPROTECTED, 0) = 0
          AND COALESCE(n.ZMARKEDFORDELETION, 0) = 0
          AND (n.ZMODIFICATIONDATE1 > ? OR (n.ZMODIFICATIONDATE1 = ? AND n.Z_PK > ?))
        ORDER BY n.ZMODIFICATIONDATE1, n.Z_PK
        LIMIT ${QUERY_LIMIT}`,
      )
      .all(cursorModified, cursorModified, cursorNoteId) as NoteRow[];

    for (const row of rows) {
      const title = row.title ?? "Untitled";
      const folder = row.folder_name ?? "Notes";
      const modifiedIso = cocoaToIso(row.modified_at ?? 0);

      let bodyText: string | null = null;
      if (row.body_data) {
        bodyText = extractTextFromNoteBody(row.body_data);
      }

      const content = bodyText
        ? `Title: ${title}\nFolder: ${folder}\nModified: ${modifiedIso ?? "unknown"}\n\n${bodyText}`
        : `Title: ${title}\nFolder: ${folder}\nModified: ${modifiedIso ?? "unknown"}`;

      const filePath = `notes/${safeName(folder)}/${safeName(title)}_${row.note_id}.txt`;

      files.push({
        path: filePath,
        content,
        metadata: {
          source_type: "local_folder",
          source_subtype: "notes",
          note_id: row.note_id,
          folder: folder,
          modified_at: modifiedIso,
        },
      });

      if (
        (row.modified_at ?? 0) > maxModifiedAt ||
        ((row.modified_at ?? 0) === maxModifiedAt && row.note_id > maxNoteId)
      ) {
        maxModifiedAt = row.modified_at ?? 0;
        maxNoteId = row.note_id;
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
      last_note_id: maxNoteId,
      last_modified_at: maxModifiedAt,
    },
    stats: { db_type: "notes", extracted: files.length },
  };
}
