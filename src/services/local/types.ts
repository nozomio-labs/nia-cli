export interface FolderCursor {
	[key: string]: unknown;
	last_mtime?: number;
	last_path?: string;
	cursor_version?: number;
	root_path?: string;
}

export interface LocalSource {
	local_folder_id: string;
	display_name?: string | null;
	path?: string | null;
	detected_type?: string | null;
	cursor?: FolderCursor | Record<string, unknown> | null;
	sync_filters?: Record<string, unknown> | null;
	sync_enabled?: boolean | null;
}

export interface LocalSourceStatus {
	id: string;
	name: string;
	path: string;
	type: string;
	status: "ready" | "path_not_found" | "needs_link";
}

export interface LocalFileItem {
	path: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export interface SyncExtractionResult {
	files: LocalFileItem[];
	cursor: Record<string, unknown>;
	stats: Record<string, unknown>;
}

export interface SyncResult {
	path: string | null;
	status: "success" | "error" | "skipped";
	added?: number;
	chunks_indexed?: number;
	message?: string;
	error?: string;
	new_cursor?: Record<string, unknown>;
}

export interface LocalSyncUploadPayload {
	local_folder_id: string;
	files: LocalFileItem[];
	cursor: Record<string, unknown>;
	stats: Record<string, unknown>;
	is_final_batch: boolean;
	connector_type?: string;
	idempotency_key?: string;
}
