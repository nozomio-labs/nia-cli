/**
 * Project-scoped binding manifest (`nia.json`).
 *
 * A `nia.json` file at a project root pins a curated set of indexed Nia
 * sources (repositories, documentation, vaults, local folders) to that
 * project. Once created, every `nia search` invocation inside that project
 * tree auto-injects those sources as the search scope — agents stop running
 * `nia sources list | head -X` to discover sources, and stop missing the
 * right one when there are 100+ indexed sources globally.
 *
 * The manifest is purely client-side; no backend changes required.
 *
 * Schema (versioned for future evolution):
 *
 * ```jsonc
 * {
 *   "$schema": "https://trynia.ai/schema/project.json",
 *   "version": 1,
 *   "name": "my-project",
 *   "sources": ["src_abc123", "vercel/next.js", "https://docs.stripe.com"],
 *   "vaults": ["vault_xyz789"],
 *   "local": [{ "path": ".", "id": "local_def456" }],
 *   "defaults": { "search_mode": "scoped" }
 * }
 * ```
 *
 * Identifiers in `sources` are flexible — UUIDs, `owner/repo` shorthand, or
 * URLs. They round-trip through `nia sources resolve` at search time, so the
 * manifest doesn't need to be re-written when a source is re-indexed.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export const MANIFEST_FILENAME = "nia.json";
export const MANIFEST_SCHEMA_URL = "https://trynia.ai/schema/project.json";
export const MANIFEST_VERSION = 1;

/** A pinned local-folder source — preserves both the on-disk path and the backend id. */
export interface ProjectLocalBinding {
	path: string;
	id?: string;
}

export interface ProjectManifest {
	$schema?: string;
	version: number;
	name?: string;
	sources: string[];
	vaults: string[];
	local: ProjectLocalBinding[];
	defaults?: {
		search_mode?: "scoped" | "unified";
	};
}

/**
 * Resolved scope ready to inject into a `nia search` payload.
 *
 * `repos` = sources of type `repository`. `docs` = sources of type
 * `documentation` / `research_paper` / `huggingface_dataset`. `localFolders` =
 * pinned local folder ids. We don't try to classify identifiers here — the
 * search command merges these into one mixed source list and the backend
 * routes by type.
 */
export interface ProjectScope {
	manifestPath: string;
	manifest: ProjectManifest;
	repos: string[];
	docs: string[];
	localFolders: string[];
	vaults: string[];
}

/**
 * Walk up from `startDir` (defaults to cwd) looking for the nearest `nia.json`.
 * Stops at the filesystem root or a directory containing `.git` (project root
 * heuristic) — whichever comes first.
 *
 * Returns the absolute path to the manifest file, or `null` if none was found.
 */
export function findProjectManifest(
	startDir: string = process.cwd(),
): string | null {
	let current = path.resolve(startDir);
	const root = path.parse(current).root;

	while (true) {
		const candidate = path.join(current, MANIFEST_FILENAME);
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}

		if (current === root) {
			return null;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/**
 * Empty manifest with the canonical defaults filled in. Used by `init` and
 * by safe migration of partially-shaped manifests.
 */
export function createEmptyManifest(name?: string): ProjectManifest {
	return {
		$schema: MANIFEST_SCHEMA_URL,
		version: MANIFEST_VERSION,
		...(name ? { name } : {}),
		sources: [],
		vaults: [],
		local: [],
		defaults: { search_mode: "scoped" },
	};
}

/**
 * Read and normalize a manifest file. Returns a `ProjectManifest` with all
 * required arrays present (so callers can do `manifest.sources.length`
 * without null-checks). Throws if the file isn't valid JSON or doesn't look
 * like a manifest at all.
 */
export function readManifest(manifestPath: string): ProjectManifest {
	const raw = readFileSync(manifestPath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${manifestPath} is not valid JSON: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${manifestPath} must contain a JSON object.`);
	}

	const obj = parsed as Record<string, unknown>;

	const sources = normalizeStringArray(obj.sources);
	const vaults = normalizeStringArray(obj.vaults);
	const local = normalizeLocalBindings(obj.local);

	return {
		$schema:
			typeof obj.$schema === "string" ? obj.$schema : MANIFEST_SCHEMA_URL,
		version:
			typeof obj.version === "number" && obj.version > 0
				? obj.version
				: MANIFEST_VERSION,
		...(typeof obj.name === "string" ? { name: obj.name } : {}),
		sources,
		vaults,
		local,
		defaults: normalizeDefaults(obj.defaults),
	};
}

/**
 * Write a manifest atomically (well, as atomically as a single fs.writeFileSync
 * can be — good enough for a config file). Pretty-prints with two spaces and a
 * trailing newline so git diffs stay clean.
 */
export function writeManifest(
	manifestPath: string,
	manifest: ProjectManifest,
): void {
	const dir = path.dirname(manifestPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const body = `${JSON.stringify(manifest, null, 2)}\n`;
	writeFileSync(manifestPath, body, "utf8");
}

/**
 * Append a source identifier to the manifest, deduplicating by exact match.
 * Returns the updated manifest (does not mutate the input).
 */
export function addSource(
	manifest: ProjectManifest,
	identifier: string,
): ProjectManifest {
	const trimmed = identifier.trim();
	if (!trimmed) {
		return manifest;
	}
	if (manifest.sources.includes(trimmed)) {
		return manifest;
	}
	return { ...manifest, sources: [...manifest.sources, trimmed] };
}

/**
 * Remove a source identifier from the manifest. Returns the updated manifest
 * (does not mutate the input). No-op if the identifier isn't present.
 */
export function removeSource(
	manifest: ProjectManifest,
	identifier: string,
): ProjectManifest {
	const trimmed = identifier.trim();
	const next = manifest.sources.filter((s) => s !== trimmed);
	if (next.length === manifest.sources.length) {
		return manifest;
	}
	return { ...manifest, sources: next };
}

/** Append a vault id, dedupe by exact match. */
export function addVault(
	manifest: ProjectManifest,
	vaultId: string,
): ProjectManifest {
	const trimmed = vaultId.trim();
	if (!trimmed || manifest.vaults.includes(trimmed)) {
		return manifest;
	}
	return { ...manifest, vaults: [...manifest.vaults, trimmed] };
}

export function removeVault(
	manifest: ProjectManifest,
	vaultId: string,
): ProjectManifest {
	const trimmed = vaultId.trim();
	const next = manifest.vaults.filter((v) => v !== trimmed);
	if (next.length === manifest.vaults.length) {
		return manifest;
	}
	return { ...manifest, vaults: next };
}

/**
 * Add or update a local-folder binding. Dedupes by `path`; if the same path
 * is added again with a new id, the id is updated in place.
 */
export function addLocalBinding(
	manifest: ProjectManifest,
	binding: ProjectLocalBinding,
): ProjectManifest {
	const trimmedPath = binding.path.trim();
	if (!trimmedPath) {
		return manifest;
	}
	const existingIndex = manifest.local.findIndex((b) => b.path === trimmedPath);
	const next = [...manifest.local];
	if (existingIndex >= 0) {
		next[existingIndex] = {
			path: trimmedPath,
			...(binding.id ? { id: binding.id } : {}),
		};
	} else {
		next.push({ path: trimmedPath, ...(binding.id ? { id: binding.id } : {}) });
	}
	return { ...manifest, local: next };
}

export function removeLocalBinding(
	manifest: ProjectManifest,
	pathOrId: string,
): ProjectManifest {
	const trimmed = pathOrId.trim();
	const next = manifest.local.filter(
		(b) => b.path !== trimmed && b.id !== trimmed,
	);
	if (next.length === manifest.local.length) {
		return manifest;
	}
	return { ...manifest, local: next };
}

/**
 * Resolve the active project scope by walking up from cwd. Returns `null` if
 * no manifest is found, or a fully-classified scope ready to inject into a
 * search payload.
 *
 * Repository identifiers are recognized by either:
 *   - matching `owner/repo` shorthand (no protocol, single slash)
 *   - looking like a github/gitlab/bitbucket URL
 *
 * Everything else in `sources` is treated as a doc/data source identifier and
 * goes into `docs`. The backend's `nia search query` payload accepts both
 * `repositories: string[]` and `data_sources: string[]`, so this client-side
 * split lets us populate them correctly without an extra round-trip to
 * `sources resolve` for every identifier.
 *
 * Local folder bindings always populate `localFolders` from their `id` if
 * present (the path-only case is rare — it means the folder was added but
 * never fully linked).
 */
export function resolveScope(startDir?: string): ProjectScope | null {
	const manifestPath = findProjectManifest(startDir);
	if (!manifestPath) {
		return null;
	}

	let manifest: ProjectManifest;
	try {
		manifest = readManifest(manifestPath);
	} catch {
		// A malformed manifest is the user's bug — don't crash the CLI on every
		// search command. Surface as "no scope" and let `nia project status`
		// be the place that explicitly reports the problem.
		return null;
	}

	const repos: string[] = [];
	const docs: string[] = [];
	for (const identifier of manifest.sources) {
		if (looksLikeRepository(identifier)) {
			repos.push(identifier);
		} else {
			docs.push(identifier);
		}
	}

	const localFolders: string[] = [];
	for (const binding of manifest.local) {
		if (binding.id) {
			localFolders.push(binding.id);
		}
	}

	return {
		manifestPath,
		manifest,
		repos,
		docs,
		localFolders,
		vaults: [...manifest.vaults],
	};
}

/**
 * Cheap heuristic to classify a source identifier as a repository vs a
 * documentation source. Errs on the side of "repo" only when the identifier
 * is unambiguously git-shaped (owner/repo or a known git host URL); anything
 * else falls through to `docs`.
 */
export function looksLikeRepository(identifier: string): boolean {
	const trimmed = identifier.trim();
	if (!trimmed) return false;

	// owner/repo shorthand, no protocol, exactly one slash
	if (
		!trimmed.includes("://") &&
		!trimmed.startsWith("/") &&
		!trimmed.endsWith("/")
	) {
		const parts = trimmed.split("/");
		const owner = parts[0];
		const repo = parts[1];
		if (
			parts.length === 2 &&
			owner !== undefined &&
			owner.length > 0 &&
			!owner.includes(".") &&
			repo !== undefined &&
			repo.length > 0
		) {
			return true;
		}
	}

	try {
		const url = new URL(trimmed);
		const host = url.host.toLowerCase();
		return (
			host === "github.com" ||
			host === "www.github.com" ||
			host === "gitlab.com" ||
			host === "www.gitlab.com" ||
			host === "bitbucket.org" ||
			host === "www.bitbucket.org"
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Internal normalization helpers
// ---------------------------------------------------------------------------

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) {
			const trimmed = item.trim();
			if (!result.includes(trimmed)) {
				result.push(trimmed);
			}
		}
	}
	return result;
}

function normalizeLocalBindings(value: unknown): ProjectLocalBinding[] {
	if (!Array.isArray(value)) return [];
	const result: ProjectLocalBinding[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) {
			result.push({ path: item.trim() });
			continue;
		}
		if (item && typeof item === "object" && !Array.isArray(item)) {
			const obj = item as Record<string, unknown>;
			const pathValue = obj.path;
			if (typeof pathValue === "string" && pathValue.trim()) {
				const trimmed = pathValue.trim();
				const id = typeof obj.id === "string" ? obj.id.trim() : undefined;
				result.push({ path: trimmed, ...(id ? { id } : {}) });
			}
		}
	}
	// Dedupe by path, preferring entries that include an id
	const byPath = new Map<string, ProjectLocalBinding>();
	for (const b of result) {
		const existing = byPath.get(b.path);
		if (!existing || (!existing.id && b.id)) {
			byPath.set(b.path, b);
		}
	}
	return Array.from(byPath.values());
}

function normalizeDefaults(value: unknown): ProjectManifest["defaults"] {
	if (!value || typeof value !== "object") {
		return { search_mode: "scoped" };
	}
	const obj = value as Record<string, unknown>;
	const mode = obj.search_mode;
	if (mode === "scoped" || mode === "unified") {
		return { search_mode: mode };
	}
	return { search_mode: "scoped" };
}
