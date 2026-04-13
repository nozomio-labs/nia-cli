import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
  copySqliteToTemp,
  openSqliteFromCopy,
  cleanupTempCopy,
  cocoaToIso,
} from "./shared.ts";

const QUERY_LIMIT = 50_000;

interface PhotoRow {
  asset_pk: number;
  filename: string | null;
  date_created: number | null;
  modified_at: number | null;
  latitude: number | null;
  longitude: number | null;
  width: number | null;
  height: number | null;
  favorite: number;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  original_file_size: number | null;
}

export function extractPhotos(
  dbPath: string,
  cursor: Record<string, unknown> = {},
): SyncExtractionResult {
  let copiedPath: string;
  try {
    copiedPath = copySqliteToTemp(dbPath, "photos");
  } catch (err) {
    return {
      files: [],
      cursor: {},
      stats: {
        db_type: "photos",
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
        db_type: "photos",
        error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const files: LocalFileItem[] = [];
  let maxModifiedAt = (cursor.last_modified_at as number) ?? 0;
  let maxAssetPk = (cursor.last_asset_pk as number) ?? 0;

  try {
    const cursorModified = (cursor.last_modified_at as number) ?? 0;
    const cursorPk = (cursor.last_asset_pk as number) ?? 0;

    const rows = db
      .query(
        `SELECT
          a.Z_PK AS asset_pk,
          a.ZFILENAME AS filename,
          a.ZDATECREATED AS date_created,
          a.ZMODIFICATIONDATE AS modified_at,
          a.ZLATITUDE AS latitude,
          a.ZLONGITUDE AS longitude,
          a.ZWIDTH AS width,
          a.ZHEIGHT AS height,
          COALESCE(a.ZFAVORITE, 0) AS favorite,
          aa.ZCAMERAMAKE AS camera_make,
          aa.ZCAMERAMODEL AS camera_model,
          aa.ZLENSMODEL AS lens_model,
          aa.ZORIGINALFILESIZE AS original_file_size
        FROM ZASSET a
        LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON a.Z_PK = aa.ZASSET
        WHERE COALESCE(a.ZTRASHEDSTATE, 0) = 0
          AND COALESCE(a.ZHIDDEN, 0) = 0
          AND (a.ZMODIFICATIONDATE > ? OR (a.ZMODIFICATIONDATE = ? AND a.Z_PK > ?))
        ORDER BY a.ZMODIFICATIONDATE, a.Z_PK
        LIMIT ${QUERY_LIMIT}`,
      )
      .all(cursorModified, cursorModified, cursorPk) as PhotoRow[];

    const dateGroups = new Map<string, PhotoRow[]>();
    for (const row of rows) {
      const createdIso = cocoaToIso(row.date_created);
      const dateKey = (createdIso ?? "unknown").slice(0, 10);
      let group = dateGroups.get(dateKey);
      if (!group) {
        group = [];
        dateGroups.set(dateKey, group);
      }
      group.push(row);
    }

    for (const [dateKey, photos] of dateGroups) {
      const lines: string[] = [`Photos from ${dateKey}`, `Count: ${photos.length}`, ""];

      for (const photo of photos) {
        const createdIso = cocoaToIso(photo.date_created);
        const parts: string[] = [];
        if (photo.filename) parts.push(`File: ${photo.filename}`);
        parts.push(`Created: ${createdIso ?? "unknown"}`);
        if (photo.width && photo.height) {
          parts.push(`Dimensions: ${photo.width}x${photo.height}`);
        }
        if (photo.latitude != null && photo.longitude != null &&
            photo.latitude !== 0 && photo.longitude !== 0) {
          parts.push(`GPS: ${photo.latitude.toFixed(6)}, ${photo.longitude.toFixed(6)}`);
        }
        if (photo.camera_make || photo.camera_model) {
          const camera = [photo.camera_make, photo.camera_model].filter(Boolean).join(" ");
          parts.push(`Camera: ${camera}`);
        }
        if (photo.lens_model) parts.push(`Lens: ${photo.lens_model}`);
        if (photo.favorite) parts.push("Favorite: Yes");
        if (photo.original_file_size) {
          const sizeMb = (photo.original_file_size / (1024 * 1024)).toFixed(1);
          parts.push(`Size: ${sizeMb}MB`);
        }
        lines.push(parts.join("\n"));
        lines.push("");
      }

      files.push({
        path: `photos/${dateKey}.txt`,
        content: lines.join("\n").trim(),
        metadata: {
          source_type: "local_folder",
          source_subtype: "photos",
          date: dateKey,
          photo_count: photos.length,
        },
      });
    }

    for (const row of rows) {
      if (
        (row.modified_at ?? 0) > maxModifiedAt ||
        ((row.modified_at ?? 0) === maxModifiedAt && row.asset_pk > maxAssetPk)
      ) {
        maxModifiedAt = row.modified_at ?? 0;
        maxAssetPk = row.asset_pk;
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
      last_modified_at: maxModifiedAt,
      last_asset_pk: maxAssetPk,
    },
    stats: { db_type: "photos", extracted: files.length },
  };
}
