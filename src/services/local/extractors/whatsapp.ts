import type { LocalFileItem, SyncExtractionResult } from "../types.ts";
import {
  copySqliteToTemp,
  openSqliteFromCopy,
  cleanupTempCopy,
  cocoaToIso,
} from "./shared.ts";

const QUERY_LIMIT = 50_000;
const TIME_WINDOW_MS = 30 * 60 * 1000;

function safeName(name: string): string {
  return name.replace(/[^\w\-_ ]/g, "_").slice(0, 50);
}

interface WhatsAppRow {
  message_id: number;
  text: string;
  message_date: number;
  chat_name: string | null;
  sender_name: string | null;
  is_from_me: number;
  message_type: number;
}

export function extractWhatsApp(
  dbPath: string,
  cursor: Record<string, unknown> = {},
): SyncExtractionResult {
  let copiedPath: string;
  try {
    copiedPath = copySqliteToTemp(dbPath, "whatsapp");
  } catch (err) {
    return {
      files: [],
      cursor: {},
      stats: {
        db_type: "whatsapp",
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
        db_type: "whatsapp",
        error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const files: LocalFileItem[] = [];
  let maxMessageDate = (cursor.last_message_date as number) ?? 0;
  let maxMessageId = (cursor.last_message_id as number) ?? 0;

  try {
    const cursorDate = (cursor.last_message_date as number) ?? 0;
    const cursorId = (cursor.last_message_id as number) ?? 0;

    const rows = db
      .query(
        `SELECT
          m.Z_PK AS message_id,
          m.ZTEXT AS text,
          m.ZMESSAGEDATE AS message_date,
          cs.ZPARTNERNAME AS chat_name,
          pn.ZPUSHNAME AS sender_name,
          m.ZISFROMME AS is_from_me,
          m.ZMESSAGETYPE AS message_type
        FROM ZWAMESSAGE m
        LEFT JOIN ZWACHATSESSION cs ON m.ZCHATSESSION = cs.Z_PK
        LEFT JOIN ZWAPROFILEPUSHNAME pn ON m.ZSENDERJIDFULL = pn.ZJID
        WHERE m.ZMESSAGETYPE IN (0, 15)
          AND m.ZTEXT IS NOT NULL
          AND m.ZTEXT != ''
          AND (m.ZMESSAGEDATE > ? OR (m.ZMESSAGEDATE = ? AND m.Z_PK > ?))
        ORDER BY m.ZMESSAGEDATE, m.Z_PK
        LIMIT ${QUERY_LIMIT}`,
      )
      .all(cursorDate, cursorDate, cursorId) as WhatsAppRow[];

    const chatGroups = new Map<string, WhatsAppRow[]>();
    for (const row of rows) {
      const chatKey = row.chat_name ?? "Unknown Chat";
      let group = chatGroups.get(chatKey);
      if (!group) {
        group = [];
        chatGroups.set(chatKey, group);
      }
      group.push(row);
    }

    for (const [chatName, messages] of chatGroups) {
      messages.sort((a, b) => a.message_date - b.message_date);

      let windowStart = 0;
      for (let i = 0; i < messages.length; i++) {
        const currentIso = cocoaToIso(messages[i].message_date);
        const startIso = cocoaToIso(messages[windowStart].message_date);
        const currentMs = currentIso
          ? new Date(currentIso).getTime()
          : 0;
        const startMs = startIso ? new Date(startIso).getTime() : 0;

        const isLastMessage = i === messages.length - 1;
        const nextExceedsWindow =
          !isLastMessage &&
          (() => {
            const nextIso = cocoaToIso(messages[i + 1].message_date);
            const nextMs = nextIso ? new Date(nextIso).getTime() : 0;
            return nextMs - startMs > TIME_WINDOW_MS;
          })();

        if (isLastMessage || nextExceedsWindow) {
          const chunk = messages.slice(windowStart, i + 1);
          const lines: string[] = [];
          for (const msg of chunk) {
            const ts = cocoaToIso(msg.message_date) ?? "unknown";
            const sender = msg.is_from_me
              ? "Me"
              : (msg.sender_name ?? "Unknown");
            lines.push(`[${ts}] ${sender}: ${msg.text}`);
          }

          const dateStr = (startIso ?? "unknown").slice(0, 10);
          const lastMsg = chunk[chunk.length - 1];
          const filePath = `whatsapp/${safeName(chatName)}/${dateStr}_${lastMsg.message_id}.txt`;

          files.push({
            path: filePath,
            content: `Chat: ${chatName}\n\n${lines.join("\n")}`,
            metadata: {
              source_type: "local_folder",
              source_subtype: "whatsapp",
              chat_name: chatName,
              message_count: chunk.length,
              window_start: startIso,
              window_end: currentIso,
            },
          });

          windowStart = i + 1;
        }
      }

      const last = messages[messages.length - 1];
      if (last.message_date > maxMessageDate || (last.message_date === maxMessageDate && last.message_id > maxMessageId)) {
        maxMessageDate = last.message_date;
        maxMessageId = last.message_id;
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
      last_message_date: maxMessageDate,
      last_message_id: maxMessageId,
    },
    stats: { db_type: "whatsapp", extracted: files.length },
  };
}
