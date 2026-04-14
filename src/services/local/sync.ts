import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { reportLocalSyncError, uploadLocalSyncBatch } from "./api.ts";
import {
	extractFolderIncremental,
	extractSqliteSource,
	FOLDER_CURSOR_VERSION,
	normalizeFolderCursor,
	TYPE_FOLDER,
} from "./extractor.ts";
import type {
	FolderCursor,
	LocalFileItem,
	LocalSource,
	SyncExtractionResult,
	SyncResult,
} from "./types.ts";

const MAX_FILES_PER_BATCH = 500;
const MAX_BATCH_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1500;
const RETRY_MAX_DELAY_MS = 15000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number | undefined): boolean {
	return status === 429 || (status !== undefined && status >= 500);
}

function toBytes(content: string): number {
	return new TextEncoder().encode(content).length;
}

function iterBatchesBySize(
	files: LocalFileItem[],
	maxBytes: number,
	maxCount: number,
): LocalFileItem[][] {
	const batches: LocalFileItem[][] = [];
	let batch: LocalFileItem[] = [];
	let size = 0;

	for (const file of files) {
		const fileSize = toBytes(file.content);
		if (fileSize > maxBytes) {
			continue;
		}

		if (
			batch.length > 0 &&
			(size + fileSize > maxBytes || batch.length >= maxCount)
		) {
			batches.push(batch);
			batch = [];
			size = 0;
		}

		batch.push(file);
		size += fileSize;
	}

	if (batch.length > 0) {
		batches.push(batch);
	}

	return batches;
}

async function uploadWithRetry(
	payload: Parameters<typeof uploadLocalSyncBatch>[0],
	apiKey?: string,
): Promise<Record<string, unknown>> {
	let delayMs = RETRY_BASE_DELAY_MS;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
		try {
			return await uploadLocalSyncBatch(payload, apiKey);
		} catch (error) {
			const status =
				error instanceof Error && "status" in error
					? Number((error as Error & { status?: number }).status)
					: undefined;

			if (!isRetryableStatus(status) || attempt === MAX_RETRIES - 1) {
				throw error;
			}

			const jitter = 0.8 + Math.random() * 0.4;
			await sleep(Math.min(RETRY_MAX_DELAY_MS, delayMs) * jitter);
			delayMs *= 2;
		}
	}

	throw new Error("Request failed after retries.");
}

function cursorsEqual(
	left: FolderCursor | undefined,
	right: FolderCursor | undefined,
): boolean {
	return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

export async function syncLocalSource(
	source: LocalSource,
	options: { apiKey?: string } = {},
): Promise<SyncResult> {
	const sourceId = source.local_folder_id;
	const sourcePath = source.path ? path.resolve(source.path) : "";

	if (!sourcePath) {
		return {
			path: null,
			status: "skipped",
			message: "No local path configured",
		};
	}

	if (!existsSync(sourcePath)) {
		const errorMessage = `Path does not exist: ${sourcePath}`;
		await reportLocalSyncError(
			sourceId,
			errorMessage,
			sourcePath,
			options.apiKey,
		);
		return {
			path: sourcePath,
			status: "error",
			error: errorMessage,
		};
	}

	const detectedType = (source.detected_type ?? TYPE_FOLDER).toLowerCase();
	const isFolderMode = detectedType === TYPE_FOLDER || detectedType === "";

	let extraction: SyncExtractionResult;
	let nextCursor: FolderCursor;
	let connectorType: string;
	let extractorCursor: FolderCursor | undefined;
	let resetReason: string | undefined;

	try {
		if (isFolderMode) {
			const normalized = normalizeFolderCursor(
				sourcePath,
				(source.cursor ?? {}) as Record<string, unknown>,
			);
			extractorCursor = normalized.cursor;
			resetReason = normalized.resetReason;
			extraction = extractFolderIncremental(sourcePath, extractorCursor);
			nextCursor = {
				...extraction.cursor,
				cursor_version: FOLDER_CURSOR_VERSION,
				root_path: sourcePath,
			};
			connectorType = TYPE_FOLDER;
		} else {
			extraction = extractSqliteSource(sourcePath, detectedType);
			nextCursor = {
				cursor_version: FOLDER_CURSOR_VERSION,
				root_path: sourcePath,
			};
			connectorType = detectedType;
		}
	} catch (error) {
		let message = error instanceof Error ? error.message : "Extraction failed";

		if (message.includes("unable to open database file") || message.includes("SQLITE_CANTOPEN")) {
			message = `Cannot open database at ${sourcePath}. Grant Full Disk Access to your terminal in System Settings > Privacy & Security > Full Disk Access.`;
		} else if (message.includes("database is locked") || message.includes("SQLITE_BUSY")) {
			message = `Database is locked by another app. Close the app using ${sourcePath} and retry.`;
		} else if (message.includes("not a database") || message.includes("SQLITE_NOTADB")) {
			message = `File at ${sourcePath} is not a valid SQLite database.`;
		}

		await reportLocalSyncError(sourceId, message, sourcePath, options.apiKey);
		return {
			path: sourcePath,
			status: "error",
			error: message,
		};
	}

	try {
		if (extraction.files.length === 0) {
			if (isFolderMode && !cursorsEqual(extractorCursor, nextCursor)) {
				await uploadWithRetry(
					{
						local_folder_id: sourceId,
						files: [],
						cursor: nextCursor as unknown as Record<string, unknown>,
						stats: extraction.stats,
						is_final_batch: true,
						connector_type: connectorType,
					},
					options.apiKey,
				);
				source.cursor = nextCursor;
				return {
					path: sourcePath,
					status: "success",
					added: 0,
					message: "No new data (cursor updated)",
					new_cursor: nextCursor,
				};
			}

			return {
				path: sourcePath,
				status: "success",
				added: 0,
				message: resetReason
					? `No new data (cursor reset: ${resetReason})`
					: "No new data",
				new_cursor: nextCursor,
			};
		}

		const batches = iterBatchesBySize(
			extraction.files,
			MAX_BATCH_SIZE_BYTES,
			MAX_FILES_PER_BATCH,
		);
		let chunksIndexed = 0;
		const syncRunId = randomUUID().replace(/-/g, "").slice(0, 12);

		for (const [index, batch] of batches.entries()) {
			const isFinalBatch = index === batches.length - 1;
			const result = await uploadWithRetry(
				{
					local_folder_id: sourceId,
					files: batch,
					cursor: isFinalBatch
						? (nextCursor as unknown as Record<string, unknown>)
						: {},
					stats: isFinalBatch ? extraction.stats : {},
					is_final_batch: isFinalBatch,
					connector_type: connectorType,
					idempotency_key: `${sourceId}:${syncRunId}:b${index + 1}`,
				},
				options.apiKey,
			);
			chunksIndexed += Number(result.chunks_indexed ?? 0);
		}

		source.cursor = nextCursor;
		return {
			path: sourcePath,
			status: "success",
			added: extraction.files.length,
			chunks_indexed: chunksIndexed,
			new_cursor: nextCursor,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Upload failed";
		await reportLocalSyncError(sourceId, message, sourcePath, options.apiKey);
		return {
			path: sourcePath,
			status: "error",
			error: message,
		};
	}
}

export async function syncLocalSources(
	sources: LocalSource[],
	options: { apiKey?: string } = {},
): Promise<SyncResult[]> {
	const results: SyncResult[] = [];

	for (const source of sources) {
		results.push(await syncLocalSource(source, options));
	}

	return results;
}
