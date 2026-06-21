import {
	accessSync,
	constants,
	existsSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { addLocalSource, listLocalSources } from "../services/local/api.ts";
import { createSdk } from "../services/sdk.ts";
import { createResponseError, withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Personal data ingestion — autonomous setup for the personal-data sources
 * Nia's backend extractors already support (iMessage, Safari history, Apple
 * Notes, Contacts, Reminders, Stickies on macOS; Chrome/Firefox history,
 * Obsidian, VSCode/Cursor workspaces, Claude Code sessions cross-platform).
 *
 * This is a thin CLI orchestration layer on top of the existing daemon endpoint
 * (`POST /v2/daemon/sources` with `detected_type: <connector>`). The backend's
 * `db_extractor.py` already knows how to extract from the SQLite databases at
 * the standard paths — this command just discovers them, registers each as a
 * local-folder source with the right `detected_type`, and (optionally) chains
 * into `nia vault init` to create a vault from the resulting source IDs.
 *
 * Designed so an agent can fulfill "index my life into a vault" in one shell
 * call: the global skill teaches the agent to chain
 *
 *   nia personal init --yes --vault "My Life"
 *
 * which discovers, registers, syncs, and creates a vault all in one go.
 */

// ---------------------------------------------------------------------------
// Personal-data source catalog
// ---------------------------------------------------------------------------
//
// Each entry maps a connector key (which the backend's db_extractor.py
// recognizes) to platform-specific path(s) where that data lives. Candidates
// are checked in order; the first existing path wins.
//
// Platform model:
// - `platforms` whitelists which OSes the source applies to (default
//   `["darwin"]` for back-compat). Sources not applicable to the current
//   platform are filtered out of discovery entirely — not reported missing.
// - `macosCandidates` / `windowsCandidates` — static paths probed on each
//   platform. The corresponding `discover` / `discoverWindows` callback (for
//   sources behind profile-keyed / versioned paths) runs first; static
//   candidates are the fallback.
// - To add Linux support later, introduce `linuxCandidates` + `discoverLinux`
//   on the spec and extend `discoverPath` with a `linux` branch.

/**
 * Where the source's content lives and which backend extractor handles it:
 * - "dedicated": db_extractor.py has a purpose-built extractor with full schema
 *   awareness. Best quality. (imessage, safari, chrome, firefox, telegram)
 * - "generic": works via the generic SQLite walker — extracts every TEXT column
 *   from every table. Schema-blind but functional. The backend's
 *   extract_db_content() falls through to extract_generic() for any unknown
 *   db_type (db_extractor.py:1521-1522), so the connector key is preserved as
 *   the source identity in MongoDB while extraction is generic.
 * - "folder": ingested via the existing local-folder daemon path. Walks the
 *   directory and emits one virtual file per text file found.
 * - "none": discoverable but no backend extractor exists yet. Surfaced in
 *   `nia personal status` as roadmap visibility, skipped by `init`.
 */
type ExtractorTier = "dedicated" | "generic" | "folder" | "none";

export type SupportedPlatform = "darwin" | "win32" | "linux";

export interface PersonalSourceSpec {
	connector: string; // user-facing key for --enable, e.g. "books", "reminders"
	displayName: string;
	description: string;
	/**
	 * Platforms this source is applicable to. Defaults to `["darwin"]` for
	 * back-compat with the original macOS-only catalog. Sources not listed for
	 * the current `process.platform` are filtered out of discovery entirely.
	 */
	platforms?: SupportedPlatform[];
	/**
	 * Static candidate paths probed on macOS in order. The first one that
	 * exists wins. For sources whose location can't be expressed as a fixed
	 * path (Firefox profiles, Anki collections, VSCode workspaceStorage), set
	 * `discover` instead — it runs custom logic to find the path at runtime.
	 */
	macosCandidates: string[];
	/**
	 * Optional custom discovery callback for macOS. Returns the resolved path
	 * if found, or null if not. Used for sources behind glob-y / profile-keyed
	 * paths (Firefox, Anki, VSCode/Cursor workspaceStorage).
	 */
	discover?: () => string | null;
	/**
	 * Static candidate paths probed on Windows. Same semantics as
	 * `macosCandidates`. Typically rooted under `%LOCALAPPDATA%` or `%APPDATA%`.
	 */
	windowsCandidates?: string[];
	/**
	 * Optional Windows discovery callback. When set, runs before
	 * `windowsCandidates`. Useful for Firefox profiles, Chrome profile dirs,
	 * Obsidian vault heuristics, etc.
	 */
	discoverWindows?: () => string | null;
	requiresFullDiskAccess: boolean;
	extractorTier: ExtractorTier;
	/**
	 * The detected_type sent to the daemon. For "dedicated" extractors this
	 * matches the backend's DB_TYPE_* constants. For "generic" sources we send
	 * the connector key so MongoDB preserves the identity, and the dispatcher's
	 * else-branch routes to extract_generic(). For "folder" mode we send "folder".
	 * For "none" it's null and registration is skipped.
	 */
	dbType: string | null;
	/**
	 * Whether `nia personal init` (without an explicit --enable list)
	 * registers this source. False for high-volume firehoses (Photos, Screen
	 * Time), sensitive data (Significant Locations), or sources that require
	 * the user to do a manual export first (Telegram).
	 */
	autoEnable: boolean;
	notes?: string;
}

const HOME = homedir();

// ---------------------------------------------------------------------------
// Custom discovery helpers
// ---------------------------------------------------------------------------

function safeListDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Find the first Firefox profile that has a places.sqlite (the history+bookmarks DB). */
function discoverFirefoxProfile(): string | null {
	const profilesDir = path.join(
		HOME,
		"Library/Application Support/Firefox/Profiles",
	);
	for (const entry of safeListDir(profilesDir)) {
		const candidate = path.join(profilesDir, entry, "places.sqlite");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Find the first Anki profile that has a collection.anki2. */
function discoverAnkiCollection(): string | null {
	const root = path.join(HOME, "Library/Application Support/Anki2");
	for (const entry of safeListDir(root)) {
		const candidate = path.join(root, entry, "collection.anki2");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Apple Books library lives in a versioned BKLibrary-*.sqlite under BKLibrary. */
function discoverAppleBooksLibrary(): string | null {
	const dir = path.join(
		HOME,
		"Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary",
	);
	for (const entry of safeListDir(dir)) {
		if (entry.startsWith("BKLibrary") && entry.endsWith(".sqlite")) {
			return path.join(dir, entry);
		}
	}
	return null;
}

/** Apple Books annotations: AEAnnotation-*.sqlite under AEAnnotation. */
function discoverAppleBooksAnnotations(): string | null {
	const dir = path.join(
		HOME,
		"Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation",
	);
	for (const entry of safeListDir(dir)) {
		if (entry.startsWith("AEAnnotation") && entry.endsWith(".sqlite")) {
			return path.join(dir, entry);
		}
	}
	return null;
}

/** Apple Photos library — point at the Photos.sqlite metadata DB inside the package. */
function discoverPhotosLibrary(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Pictures/Photos Library.photoslibrary/database/Photos.sqlite",
		),
		path.join(HOME, "Pictures/Photos Library.photoslibrary/database/photos.db"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Things 3 main database. */
function discoverThings3(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Things Database.thingsdatabase/main.sqlite",
		),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** OmniFocus 3 or 4 — pick whichever exists. */
function discoverOmniFocus(): string | null {
	const candidates = [
		path.join(HOME, "Library/Group Containers/com.omnigroup.OmniFocus4"),
		path.join(HOME, "Library/Group Containers/com.omnigroup.OmniFocus3"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Bear notes SQLite. */
function discoverBear(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite",
		),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Day One journal SQLite. */
function discoverDayOne(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Group Containers/5U8NS4GX82.dayoneapp2/Data/Auto Backup",
		),
		path.join(HOME, "Library/Group Containers/5U8NS4GX82.dayoneapp2/Data"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Apple Podcasts MTLibrary — listening history + subscriptions. */
function discoverApplePodcasts(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite",
		),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Apple Reminders DB. */
function discoverReminders(): string | null {
	const candidates = [
		path.join(HOME, "Library/Reminders/Container_v1/Stores"),
		path.join(HOME, "Library/Group Containers/group.com.apple.reminders"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Apple Contacts AddressBook database. Walks Sources/<uuid>/AddressBook-v22.abcddb. */
function discoverContacts(): string | null {
	const sourcesDir = path.join(
		HOME,
		"Library/Application Support/AddressBook/Sources",
	);
	for (const uuid of safeListDir(sourcesDir)) {
		const candidate = path.join(sourcesDir, uuid, "AddressBook-v22.abcddb");
		if (existsSync(candidate)) return candidate;
	}
	const fallback = path.join(HOME, "Library/Application Support/AddressBook");
	return existsSync(fallback) ? fallback : null;
}

/** macOS Significant Locations cache. */
function discoverSignificantLocations(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Application Support/com.apple.routined/Cache.sqlite",
		),
		path.join(HOME, "Library/Application Support/com.apple.routined"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Voice Memos metadata DB (audio still needs a transcription pass). */
function discoverVoiceMemosMetadata(): string | null {
	const candidates = [
		path.join(
			HOME,
			"Library/Application Support/com.apple.voicememos/Recordings/CloudRecordings.db",
		),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/** Find an Obsidian vault by probing common locations. */
function discoverObsidianVault(): string | null {
	const candidates = [
		path.join(HOME, "Documents/Obsidian"),
		path.join(HOME, "Obsidian"),
		path.join(HOME, "Documents"),
	];
	for (const c of candidates) {
		// Heuristic: an Obsidian vault has a .obsidian/ directory inside.
		if (existsSync(path.join(c, ".obsidian"))) return c;
		// Or any subdirectory of c that contains .obsidian.
		for (const sub of safeListDir(c)) {
			const subPath = path.join(c, sub);
			if (existsSync(path.join(subPath, ".obsidian"))) return subPath;
		}
	}
	return null;
}

/** Most-recently-modified VSCode workspaceStorage entry. */
function discoverVSCodeWorkspaceStorage(): string | null {
	const root = path.join(
		HOME,
		"Library/Application Support/Code/User/workspaceStorage",
	);
	return existsSync(root) ? root : null;
}

/** Cursor workspaceStorage (chromium-based, same shape as VSCode). */
function discoverCursorWorkspaceStorage(): string | null {
	const root = path.join(
		HOME,
		"Library/Application Support/Cursor/User/workspaceStorage",
	);
	return existsSync(root) ? root : null;
}

/**
 * Claude Code project conversations. Cross-platform: reads from
 * `~/.claude/projects` which resolves correctly on both macOS and Windows via
 * `os.homedir()`. Used as both `discover` and `discoverWindows` in the catalog.
 *
 * Reads `homedir()` at call time (not the module-level HOME const) so tests
 * can override HOME / USERPROFILE — matches the contract used by every other
 * Windows discovery helper (see `discoverObsidianVaultWindows`).
 */
function discoverClaudeCodeHistory(): string | null {
	const root = path.join(homedir(), ".claude/projects");
	return existsSync(root) ? root : null;
}

// ---------------------------------------------------------------------------
// Windows discovery helpers
// ---------------------------------------------------------------------------
//
// Windows doesn't have stable tilde-style `~/Library/...` paths — personal
// data sits under `%LOCALAPPDATA%` (machine-local) or `%APPDATA%` (roaming).
// We resolve those env vars with a fallback to `homedir()\AppData\...` so
// tests (which can override USERPROFILE) and non-standard shells still work.

function winEnv(key: string): string | null {
	const v = process.env[key];
	return v && v.length > 0 ? v : null;
}

function localAppData(): string {
	return winEnv("LOCALAPPDATA") ?? path.join(homedir(), "AppData", "Local");
}

function appData(): string {
	return winEnv("APPDATA") ?? path.join(homedir(), "AppData", "Roaming");
}

/**
 * Chrome on Windows stores History under
 * `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\History`. Probe the
 * Default profile first, then any `Profile N` directories.
 */
export function discoverChromeHistoryWindows(): string | null {
	const userData = path.join(localAppData(), "Google", "Chrome", "User Data");
	const defaultHistory = path.join(userData, "Default", "History");
	if (existsSync(defaultHistory)) return defaultHistory;
	// Sort numerically so `Profile 2` wins over `Profile 10` (lexicographic
	// sort would flip them). Readdir order is filesystem-dependent on Windows.
	const byProfileNumber = (a: string, b: string) => {
		const na = parseInt(a.slice("Profile ".length), 10);
		const nb = parseInt(b.slice("Profile ".length), 10);
		return (
			(Number.isNaN(na) ? Infinity : na) - (Number.isNaN(nb) ? Infinity : nb)
		);
	};
	for (const entry of safeListDir(userData).sort(byProfileNumber)) {
		if (entry.startsWith("Profile")) {
			const candidate = path.join(userData, entry, "History");
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** Find the first Firefox profile with a places.sqlite on Windows. */
export function discoverFirefoxProfileWindows(): string | null {
	const profilesDir = path.join(appData(), "Mozilla", "Firefox", "Profiles");
	for (const entry of safeListDir(profilesDir)) {
		const candidate = path.join(profilesDir, entry, "places.sqlite");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Find an Obsidian vault on Windows. Checks common locations including
 * OneDrive-redirected Documents folders — most Windows users have that
 * redirection enabled by default on modern Windows 10/11 — and Apple's
 * iCloud Drive container (`iCloudDrive\iCloud~md~obsidian\<vault>`), which
 * is how Obsidian's mobile iCloud sync surfaces vaults on Windows when the
 * user has iCloud for Windows installed.
 */
export function discoverObsidianVaultWindows(): string | null {
	// Read homedir at call time (not the module-level HOME const) so tests can
	// override USERPROFILE to point at a temp dir.
	const home = homedir();
	const roots = [
		path.join(home, "Documents", "Obsidian"),
		path.join(home, "Obsidian"),
		path.join(home, "OneDrive", "Documents", "Obsidian"),
		path.join(home, "OneDrive", "Obsidian"),
		path.join(home, "iCloudDrive", "iCloud~md~obsidian"),
		path.join(home, "Documents"),
		path.join(home, "OneDrive", "Documents"),
	];
	for (const c of roots) {
		if (existsSync(path.join(c, ".obsidian"))) return c;
		for (const sub of safeListDir(c)) {
			const subPath = path.join(c, sub);
			if (existsSync(path.join(subPath, ".obsidian"))) return subPath;
		}
	}
	return null;
}

/** VSCode workspaceStorage on Windows. */
export function discoverVSCodeWorkspaceStorageWindows(): string | null {
	const root = path.join(appData(), "Code", "User", "workspaceStorage");
	return existsSync(root) ? root : null;
}

/** Cursor workspaceStorage on Windows. */
export function discoverCursorWorkspaceStorageWindows(): string | null {
	const root = path.join(appData(), "Cursor", "User", "workspaceStorage");
	return existsSync(root) ? root : null;
}

/**
 * Windows Timeline / Activity History. The `ConnectedDevicesPlatform` service
 * writes one `ActivitiesCache.db` per device, under a device-hash subdirectory
 * (e.g. `da9ed9198cc45ad3/`) — sometimes `L.<username>/` on older builds.
 * Scan all subdirs of the root for the file and return the first match.
 */
export function discoverWindowsTimeline(): string | null {
	const root = path.join(localAppData(), "ConnectedDevicesPlatform");
	for (const entry of safeListDir(root)) {
		const candidate = path.join(root, entry, "ActivitiesCache.db");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * PowerShell command history via PSReadLine. Two variants exist:
 *   - PowerShell 7+ (`pwsh`, modern default): `%APPDATA%\Microsoft\PowerShell\PSReadLine\`
 *   - Windows PowerShell 5.1 (legacy, built-in): `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\`
 *
 * Each directory holds `ConsoleHost_history.txt` plus one `<host>_history.txt`
 * per shell host (VSCode, ISE, etc.). We prefer the pwsh path when both exist
 * — it's the modern default and where active users write history today.
 * Return the parent directory so the folder extractor ingests every host file.
 */
export function discoverPowerShellHistoryWindows(): string | null {
	const candidates = [
		path.join(appData(), "Microsoft", "PowerShell", "PSReadLine"),
		path.join(appData(), "Microsoft", "Windows", "PowerShell", "PSReadLine"),
	];
	for (const root of candidates) {
		if (existsSync(root)) return root;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const PERSONAL_SOURCES: PersonalSourceSpec[] = [
	// ─────────────────────────────────────────────────────────────────────
	// Tier 1 — dedicated backend extractors (full schema awareness)
	// ─────────────────────────────────────────────────────────────────────
	{
		connector: "imessage",
		displayName: "iMessage",
		description:
			"Messages.app conversations: 1-on-1, group chats, attachment metadata",
		macosCandidates: [path.join(HOME, "Library/Messages/chat.db")],
		requiresFullDiskAccess: true,
		extractorTier: "dedicated",
		dbType: "imessage",
		autoEnable: true,
	},
	{
		connector: "safari_history",
		displayName: "Safari History",
		description:
			"Safari browsing history: URLs, page titles, visit counts, timestamps",
		macosCandidates: [path.join(HOME, "Library/Safari/History.db")],
		requiresFullDiskAccess: true,
		extractorTier: "dedicated",
		dbType: "safari_history",
		autoEnable: true,
	},
	{
		connector: "chrome_history",
		displayName: "Chrome History",
		description: "Google Chrome browsing history (URLs, titles, visit times)",
		platforms: ["darwin", "win32"],
		macosCandidates: [
			path.join(
				HOME,
				"Library/Application Support/Google/Chrome/Default/History",
			),
		],
		discoverWindows: discoverChromeHistoryWindows,
		requiresFullDiskAccess: false,
		extractorTier: "dedicated",
		dbType: "chrome_history",
		autoEnable: true,
		notes:
			"Chrome locks the History DB while Chrome is running. Quit Chrome before sync, or the daemon copies it first. On Windows, probes %LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>\\History — Default first, then Profile N directories.",
	},
	{
		connector: "firefox_history",
		displayName: "Firefox History",
		description: "Mozilla Firefox browsing history + bookmarks (places.sqlite)",
		platforms: ["darwin", "win32"],
		macosCandidates: [],
		discover: discoverFirefoxProfile,
		discoverWindows: discoverFirefoxProfileWindows,
		requiresFullDiskAccess: false,
		extractorTier: "dedicated",
		dbType: "firefox_history",
		autoEnable: true,
		notes:
			"Probes ~/Library/Application Support/Firefox/Profiles/<profile>/places.sqlite on macOS and %APPDATA%\\Mozilla\\Firefox\\Profiles\\<profile>\\places.sqlite on Windows. Picks the first profile that has one.",
	},
	{
		connector: "telegram",
		displayName: "Telegram Desktop",
		description:
			"Telegram chat history (requires manual JSON export from the app first)",
		macosCandidates: [
			path.join(HOME, "Downloads/Telegram Desktop"),
			path.join(HOME, "Documents/Telegram Desktop"),
		],
		requiresFullDiskAccess: false,
		extractorTier: "dedicated",
		dbType: "telegram",
		autoEnable: false,
		notes:
			"Telegram Desktop doesn't expose its DB. To ingest: Settings → Advanced → Export Telegram Data → Export to JSON, then re-run init.",
	},

	// ─────────────────────────────────────────────────────────────────────
	// Tier 2 — generic SQLite extraction (works today, schema-unaware but functional)
	// The backend dispatcher routes unknown db_type values to extract_generic(),
	// which walks every TEXT column across every table. The connector key is
	// preserved in MongoDB so source identity is intact.
	// ─────────────────────────────────────────────────────────────────────
	{
		connector: "notes",
		displayName: "Apple Notes",
		description: "Notes.app — all folders, notes, and attachment metadata",
		macosCandidates: [
			path.join(
				HOME,
				"Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
			),
		],
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "notes",
		autoEnable: true,
		notes:
			"Backend has a 'notes' connector key but the dedicated extractor is TODO; falls through to generic SQLite extraction (db_extractor.py:1505-1508).",
	},
	{
		connector: "whatsapp",
		displayName: "WhatsApp",
		description: "WhatsApp Desktop chat history (ChatStorage.sqlite)",
		macosCandidates: [
			path.join(
				HOME,
				"Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
			),
			path.join(
				HOME,
				"Library/Containers/net.whatsapp.WhatsApp/Data/Library/Application Support/WhatsApp/ChatStorage.sqlite",
			),
		],
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "whatsapp",
		autoEnable: true,
		notes:
			"Backend has a 'whatsapp' connector key but the dedicated extractor is TODO; falls through to generic.",
	},
	{
		connector: "reminders",
		displayName: "Apple Reminders",
		description:
			"Apple Reminders.app — all lists, items, due dates, completion state",
		macosCandidates: [],
		discover: discoverReminders,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "reminders",
		autoEnable: true,
	},
	{
		connector: "contacts",
		displayName: "Apple Contacts",
		description:
			"Apple Contacts.app — names, emails, phones, organizations, groups, notes",
		macosCandidates: [],
		discover: discoverContacts,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "contacts",
		autoEnable: true,
	},
	{
		connector: "books",
		displayName: "Apple Books",
		description:
			"Apple Books library: titles, authors, reading progress, collections",
		macosCandidates: [],
		discover: discoverAppleBooksLibrary,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "books",
		autoEnable: true,
	},
	{
		connector: "books_annotations",
		displayName: "Apple Books — Annotations",
		description:
			"Apple Books highlights, margin notes, and underlines (separate DB from the library)",
		macosCandidates: [],
		discover: discoverAppleBooksAnnotations,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "books_annotations",
		autoEnable: true,
	},
	{
		connector: "podcasts",
		displayName: "Apple Podcasts",
		description:
			"Podcasts.app: subscriptions, listening history, episode metadata",
		macosCandidates: [],
		discover: discoverApplePodcasts,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "podcasts",
		autoEnable: false,
		notes: "High-volume listening data. Opt-in via --enable.",
	},
	{
		connector: "anki",
		displayName: "Anki",
		description:
			"Anki spaced-repetition collection: cards, notes, review history, scheduling",
		macosCandidates: [],
		discover: discoverAnkiCollection,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "anki",
		autoEnable: false,
		notes:
			"Picks the first Anki profile under ~/Library/Application Support/Anki2.",
	},
	{
		connector: "day_one",
		displayName: "Day One Journal",
		description: "Day One journal entries, photos metadata, locations, weather",
		macosCandidates: [],
		discover: discoverDayOne,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "day_one",
		autoEnable: false,
	},
	{
		connector: "bear",
		displayName: "Bear Notes",
		description: "Bear note-taking app — notes, tags, attachment metadata",
		macosCandidates: [],
		discover: discoverBear,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "bear",
		autoEnable: false,
	},
	{
		connector: "things",
		displayName: "Things 3",
		description:
			"Things 3 task manager: projects, areas, tasks, tags, due dates, deadlines",
		macosCandidates: [],
		discover: discoverThings3,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "things",
		autoEnable: false,
	},
	{
		connector: "omnifocus",
		displayName: "OmniFocus",
		description:
			"OmniFocus task manager: projects, perspectives, tags, contexts",
		macosCandidates: [],
		discover: discoverOmniFocus,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "omnifocus",
		autoEnable: false,
	},
	{
		connector: "photos_metadata",
		displayName: "Apple Photos (metadata)",
		description:
			"Photos.app metadata: faces, places (GPS), dates, captions, albums, memories. Image bytes are NOT ingested.",
		macosCandidates: [],
		discover: discoverPhotosLibrary,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "photos_metadata",
		autoEnable: false,
		notes:
			"Photos.sqlite has one row per photo — generic extraction caps at MAX_TOTAL_ROWS in the backend. Useful for queries like 'where was that trip in 2024'.",
	},
	{
		connector: "screen_time",
		displayName: "Screen Time / knowledgeC",
		description:
			"macOS Screen Time DB: app launches, web visits across all browsers, focus modes, screen unlocks, ~90 days of behavioral data. THE source for 'what did I actually do today'.",
		macosCandidates: [
			path.join(HOME, "Library/Application Support/Knowledge/knowledgeC.db"),
		],
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "screen_time",
		autoEnable: false,
		notes:
			"knowledgeC.db is the crown jewel for behavioral indexing. High-volume — generic extraction caps it. Opt-in via --enable.",
	},
	{
		connector: "significant_locations",
		displayName: "Significant Locations",
		description:
			"Apple's location history: where you've physically been, with timestamps. From System Settings → Privacy & Security → Location Services → System Services → Significant Locations.",
		macosCandidates: [],
		discover: discoverSignificantLocations,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "significant_locations",
		autoEnable: false,
		notes: "Highly sensitive. Off by default. Opt-in via --enable.",
	},
	{
		connector: "voice_memos_metadata",
		displayName: "Voice Memos (metadata)",
		description:
			"Voice Memos.app: recording names, durations, dates, locations. Audio bytes are NOT transcribed (separate roadmap item).",
		macosCandidates: [],
		discover: discoverVoiceMemosMetadata,
		requiresFullDiskAccess: true,
		extractorTier: "generic",
		dbType: "voice_memos",
		autoEnable: false,
	},
	{
		connector: "windows_timeline",
		displayName: "Windows Timeline",
		description:
			"Windows Activity History (ActivitiesCache.db) — app launches, visited URLs, foreground windows, clipboard content the OS captured while Timeline was enabled.",
		platforms: ["win32"],
		macosCandidates: [],
		windowsCandidates: [],
		discoverWindows: discoverWindowsTimeline,
		requiresFullDiskAccess: false,
		extractorTier: "generic",
		dbType: "windows_timeline",
		autoEnable: false,
		notes:
			"Probes %LOCALAPPDATA%\\ConnectedDevicesPlatform\\<device-hash>\\ActivitiesCache.db — device-hash subdir (or older L.<username>) is scanned automatically. Backend falls through to the generic TEXT-column walker until a dedicated extractor lands; a schema-aware extractor (Activity, ActivityOperation tables, AppId/Payload JSON) is the natural follow-up. Off by default because output is noisier than dedicated sources.",
	},

	// ─────────────────────────────────────────────────────────────────────
	// Tier 3 — folder mode (ingested as a generic folder by the local sync daemon)
	// ─────────────────────────────────────────────────────────────────────
	{
		connector: "mail",
		displayName: "Apple Mail",
		description:
			"Apple Mail.app local IMAP cache. Each .mbox/Messages/ holds .emlx (RFC2822) message files.",
		macosCandidates: [path.join(HOME, "Library/Mail")],
		requiresFullDiskAccess: true,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes:
			"Folder mode walks the directory tree. .emlx files are RFC2822 with a small plist trailer — readable as text. A dedicated extractor would do better but folder mode produces useful output today.",
	},
	{
		connector: "calendar",
		displayName: "Apple Calendar",
		description:
			"Apple Calendar.app local data. Per-calendar directories with Events/<uuid>.ics files.",
		macosCandidates: [path.join(HOME, "Library/Calendars")],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: true,
		notes:
			"ICS files are plain text (vcalendar format). Folder mode produces directly-usable output.",
	},
	{
		connector: "stickies",
		displayName: "Stickies",
		description: "Stickies.app desktop notes (RTF files)",
		macosCandidates: [
			path.join(
				HOME,
				"Library/Containers/com.apple.Stickies/Data/Library/Stickies",
			),
		],
		requiresFullDiskAccess: true,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: true,
		notes:
			"Stickies are RTF files. Folder mode reads them as text (RTF markup will be visible — a dedicated parser would clean it up).",
	},
	{
		connector: "obsidian",
		displayName: "Obsidian Vault",
		description:
			"Obsidian markdown vault — notes, links, daily notes, attachments",
		platforms: ["darwin", "win32"],
		macosCandidates: [],
		discover: discoverObsidianVault,
		discoverWindows: discoverObsidianVaultWindows,
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: true,
		notes:
			"Discovers any directory containing .obsidian/ under ~/Documents/, ~/Documents/Obsidian/, or ~/Obsidian/ on macOS; on Windows also probes OneDrive-redirected Documents folders and Apple iCloud Drive vaults at ~/iCloudDrive/iCloud~md~obsidian/<vault>.",
	},
	{
		connector: "icloud_drive",
		displayName: "iCloud Drive",
		description: "All files synced to iCloud Drive",
		macosCandidates: [
			path.join(HOME, "Library/Mobile Documents/com~apple~CloudDocs"),
		],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes:
			"iCloud Drive can be huge. Opt-in via --enable. The local sync daemon walks the directory and uploads text files.",
	},
	{
		connector: "documents",
		displayName: "Documents folder",
		description: "Everything under ~/Documents",
		macosCandidates: [path.join(HOME, "Documents")],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes: "Opt-in via --enable.",
	},
	{
		connector: "downloads",
		displayName: "Downloads folder",
		description: "Recent files in ~/Downloads",
		macosCandidates: [path.join(HOME, "Downloads")],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
	},
	{
		connector: "desktop",
		displayName: "Desktop folder",
		description:
			"Files on the macOS Desktop (includes screenshots if you keep them there)",
		macosCandidates: [path.join(HOME, "Desktop")],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
	},

	// ─────────────────────────────────────────────────────────────────────
	// Tier 5 — developer brain dump (high-signal SQLite/folders for power users)
	// ─────────────────────────────────────────────────────────────────────
	{
		connector: "vscode_workspaces",
		displayName: "VSCode Workspace History",
		description:
			"VSCode per-workspace state (recent files, search history, terminal output). Each workspaceStorage/<hash>/state.vscdb is a SQLite.",
		platforms: ["darwin", "win32"],
		macosCandidates: [],
		discover: discoverVSCodeWorkspaceStorage,
		discoverWindows: discoverVSCodeWorkspaceStorageWindows,
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes:
			"Folder mode walks all workspaces. The .vscdb files inside are SQLite — generic extraction catches them too.",
	},
	{
		connector: "cursor_workspaces",
		displayName: "Cursor Workspace History",
		description:
			"Cursor (Chromium-based VSCode fork) per-workspace state — same shape as VSCode",
		platforms: ["darwin", "win32"],
		macosCandidates: [],
		discover: discoverCursorWorkspaceStorage,
		discoverWindows: discoverCursorWorkspaceStorageWindows,
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
	},
	{
		connector: "claude_code_history",
		displayName: "Claude Code Session History",
		description:
			"Per-project Claude Code conversation transcripts (~/.claude/projects/<proj>/conversations/*.jsonl). What you've discussed with the agent.",
		platforms: ["darwin", "win32"],
		macosCandidates: [],
		discover: discoverClaudeCodeHistory,
		discoverWindows: discoverClaudeCodeHistory,
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes:
			"Recursive privacy: indexing your agent conversations into a vault that the agent then reads creates an interesting feedback loop. Off by default. Works identically on macOS and Windows — ~/.claude/projects is resolved via os.homedir() at call time on both.",
	},
	{
		connector: "powershell_history",
		displayName: "PowerShell History",
		description:
			"PSReadLine command history — ConsoleHost_history.txt plus per-host files (VSCode integrated terminal, ISE, etc.). Plain text, one command per line.",
		platforms: ["win32"],
		macosCandidates: [],
		windowsCandidates: [],
		discoverWindows: discoverPowerShellHistoryWindows,
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		notes:
			"Registers the PSReadLine directory as a folder source — PowerShell 7 (%APPDATA%\\Microsoft\\PowerShell\\PSReadLine\\) if present, else Windows PowerShell 5.1 (%APPDATA%\\Microsoft\\Windows\\PowerShell\\PSReadLine\\). Every *_history.txt under it is ingested by the folder walker. Off by default — shell history leaks secrets if you've ever pasted credentials into a terminal.",
	},

	// ─────────────────────────────────────────────────────────────────────
	// Tier 6 — discoverable but no backend extractor yet (visible in status, skipped by init)
	// These are surfaced for roadmap visibility so the agent/user knows what's coming.
	// ─────────────────────────────────────────────────────────────────────
	{
		connector: "voice_memos_audio",
		displayName: "Voice Memos (audio)",
		description:
			"Voice Memos.app M4A audio files — needs transcription before useful",
		macosCandidates: [
			path.join(
				HOME,
				"Library/Application Support/com.apple.voicememos/Recordings",
			),
		],
		requiresFullDiskAccess: true,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"Backend extractor needed: walk M4A files + transcribe via Whisper or AssemblyAI. The voice_memos_metadata source above gets you names and dates today.",
	},
	{
		connector: "screenshots_ocr",
		displayName: "Screenshots (OCR)",
		description:
			"Desktop screenshots — needs OCR (Vision framework / Tesseract / Claude vision) to extract text",
		macosCandidates: [path.join(HOME, "Desktop")],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"Backend extractor needed. Use the desktop folder source above to ingest screenshot filenames + dates today.",
	},
	{
		connector: "discord",
		displayName: "Discord Desktop",
		description: "Discord chat cache (Electron LevelDB)",
		macosCandidates: [path.join(HOME, "Library/Application Support/discord")],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"LevelDB extractor needed. Discord stores message cache as opaque blobs.",
	},
	{
		connector: "signal",
		displayName: "Signal Desktop",
		description: "Signal Desktop chat history (encrypted SQLite)",
		macosCandidates: [path.join(HOME, "Library/Application Support/Signal")],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"Signal's database is encrypted with a key in the macOS Keychain. Decryption is technically possible but intentionally hostile.",
	},
	{
		connector: "slack_desktop",
		displayName: "Slack Desktop Cache",
		description: "Slack Desktop local message cache (Electron LevelDB)",
		macosCandidates: [
			path.join(HOME, "Library/Application Support/Slack/storage"),
		],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"For Slack data, use the Slack API connector via `nia connectors install slack` instead — far better quality.",
	},
	{
		connector: "shell_history",
		displayName: "Shell history",
		description:
			"Zsh/Bash/Fish command history files (~/.zsh_history, ~/.bash_history, ~/.local/share/fish/fish_history)",
		macosCandidates: [
			path.join(HOME, ".zsh_history"),
			path.join(HOME, ".bash_history"),
		],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"Single-file sources need a small daemon-side adapter. For now, manually add the parent dir: `nia local add ~/`.",
	},
	{
		connector: "apps_installed",
		displayName: "Installed Applications",
		description:
			"Snapshot of /Applications + ~/Applications with version metadata from Info.plist",
		macosCandidates: ["/Applications"],
		requiresFullDiskAccess: false,
		extractorTier: "none",
		dbType: null,
		autoEnable: false,
		notes:
			"Snapshot-style sources need a different ingestion model (run command, capture output). Roadmap item.",
	},
];

const ALL_CONNECTORS = PERSONAL_SOURCES.map((s) => s.connector);

interface DiscoveryResult {
	connector: string;
	displayName: string;
	description: string;
	resolvedPath: string | null;
	exists: boolean;
	readable: boolean;
	requiresFullDiskAccess: boolean;
	extractorTier: ExtractorTier;
	dbType: string | null;
	autoEnable: boolean;
	alreadyRegistered: boolean;
	existingSourceId: string | null;
	notes?: string;
}

function probeReadable(p: string): boolean {
	try {
		accessSync(p, constants.R_OK);
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

const DEFAULT_PLATFORMS: SupportedPlatform[] = ["darwin"];

function getPlatforms(spec: PersonalSourceSpec): SupportedPlatform[] {
	return spec.platforms ?? DEFAULT_PLATFORMS;
}

export function isApplicableToCurrentPlatform(
	spec: PersonalSourceSpec,
): boolean {
	const current = process.platform as SupportedPlatform;
	return getPlatforms(spec).includes(current);
}

/** Resolve the (discover, candidates) pair for a spec on the current platform. */
export function resolvePlatformSources(spec: PersonalSourceSpec): {
	discover?: () => string | null;
	candidates: string[];
} {
	if (process.platform === "win32") {
		return {
			discover: spec.discoverWindows,
			candidates: spec.windowsCandidates ?? [],
		};
	}
	// darwin (and anything else that opts in via `platforms`) — uses the
	// original mac discovery + macosCandidates. Linux support would add a
	// branch here paired with `discoverLinux` / `linuxCandidates` fields.
	return {
		discover: spec.discover,
		candidates: spec.macosCandidates,
	};
}

export function discoverPath(spec: PersonalSourceSpec): {
	resolvedPath: string | null;
	exists: boolean;
	readable: boolean;
} {
	const { discover, candidates } = resolvePlatformSources(spec);

	// Custom discovery wins (Firefox profiles, Anki collections, Apple Books
	// versioned databases, Photos library, Chrome profiles on Windows, etc.).
	if (discover) {
		try {
			const resolved = discover();
			if (resolved && existsSync(resolved)) {
				return {
					resolvedPath: resolved,
					exists: true,
					readable: probeReadable(resolved),
				};
			}
		} catch {
			// fall through to static candidates
		}
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return {
				resolvedPath: candidate,
				exists: true,
				readable: probeReadable(candidate),
			};
		}
	}
	return { resolvedPath: null, exists: false, readable: false };
}

async function discoverAll(apiKey?: string): Promise<DiscoveryResult[]> {
	// Cross-reference with what's already registered in Nia so we can show
	// "already enabled" status and skip re-registration. We key on BOTH the
	// connector key (preferred) AND the resolved path, because folder-mode
	// sources all share `detected_type=folder` and disambiguate by path.
	let existingSources: Awaited<ReturnType<typeof listLocalSources>> = [];
	try {
		existingSources = await listLocalSources(apiKey);
	} catch {
		// Best-effort; continue with empty list.
	}

	const byConnector = new Map<string, { id: string; path?: string }>();
	const byPath = new Map<string, { id: string }>();
	for (const source of existingSources) {
		const detected = source.detected_type;
		if (detected) {
			byConnector.set(detected, {
				id: source.local_folder_id,
				path: source.path ?? undefined,
			});
		}
		if (source.path) {
			byPath.set(path.resolve(source.path), { id: source.local_folder_id });
		}
	}

	// Filter out sources that aren't applicable to the current platform so
	// Windows users don't see 30 macOS-only entries as "not found" and vice
	// versa. Sources are only probed if their `platforms` list includes
	// `process.platform`.
	const applicable = PERSONAL_SOURCES.filter(isApplicableToCurrentPlatform);

	return applicable.map((spec) => {
		const { resolvedPath, exists, readable } = discoverPath(spec);
		// Match by connector key first; for folder-mode sources, also try
		// matching by resolved path so we don't double-register the same dir.
		let existing = byConnector.get(spec.connector);
		if (!existing && resolvedPath) {
			const byResolved = byPath.get(path.resolve(resolvedPath));
			if (byResolved) existing = byResolved;
		}
		return {
			connector: spec.connector,
			displayName: spec.displayName,
			description: spec.description,
			resolvedPath,
			exists,
			readable,
			requiresFullDiskAccess: spec.requiresFullDiskAccess,
			extractorTier: spec.extractorTier,
			dbType: spec.dbType,
			autoEnable: spec.autoEnable,
			alreadyRegistered: Boolean(existing),
			existingSourceId: existing?.id ?? null,
			notes: spec.notes,
		};
	});
}

/** Group discovery results by tier for display. */
function groupByTier(
	results: DiscoveryResult[],
): Record<ExtractorTier, DiscoveryResult[]> {
	const groups: Record<ExtractorTier, DiscoveryResult[]> = {
		dedicated: [],
		generic: [],
		folder: [],
		none: [],
	};
	for (const r of results) {
		groups[r.extractorTier].push(r);
	}
	return groups;
}

export function parseEnableList(raw: string | undefined): string[] | null {
	if (!raw || raw === "all") return null; // null = all known
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function serializeResult(r: DiscoveryResult): Record<string, unknown> {
	return {
		connector: r.connector,
		display_name: r.displayName,
		description: r.description,
		extractor_tier: r.extractorTier,
		db_type: r.dbType,
		auto_enable: r.autoEnable,
		exists: r.exists,
		readable: r.readable,
		already_registered: r.alreadyRegistered,
		existing_source_id: r.existingSourceId,
		path: r.resolvedPath,
		requires_full_disk_access: r.requiresFullDiskAccess,
		note: r.notes,
	};
}

const statusCommand = app
	.sub("status")
	.meta({
		description:
			"Probe the current OS for all known personal-data sources applicable to that platform (macOS: 30+ including iMessage, browsers, knowledge tools, calendars, mail, journals, code histories; Windows: Chrome/Firefox history, Obsidian, VSCode/Cursor workspaces, Claude Code sessions) and report which exist, which are readable, which are already registered with Nia, and which need new backend extractors.",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Personal" }, async () => {
			const results = await discoverAll(flags["api-key"]);
			const groups = groupByTier(results);

			fmt.output({
				platform: process.platform,
				home: homedir(),
				tiers: {
					tier_1_dedicated_extractor: groups.dedicated.map(serializeResult),
					tier_2_generic_sqlite_extraction: groups.generic.map(serializeResult),
					tier_3_folder_mode: groups.folder.map(serializeResult),
					tier_6_roadmap_no_extractor_yet: groups.none.map(serializeResult),
				},
				summary: {
					total_known_sources: results.length,
					discovered: results.filter((r) => r.exists).length,
					readable: results.filter((r) => r.exists && r.readable).length,
					blocked_on_permissions: results.filter(
						(r) => r.exists && !r.readable && r.requiresFullDiskAccess,
					).length,
					already_registered: results.filter((r) => r.alreadyRegistered).length,
					ready_to_register: results.filter(
						(r) =>
							r.exists &&
							r.readable &&
							!r.alreadyRegistered &&
							r.extractorTier !== "none",
					).length,
					needs_new_backend_extractor: groups.none.length,
					tier_breakdown: {
						dedicated: groups.dedicated.length,
						generic_sqlite: groups.generic.length,
						folder: groups.folder.length,
						none: groups.none.length,
					},
				},
			});

			const blocked = results.filter(
				(r) =>
					r.exists &&
					!r.readable &&
					r.requiresFullDiskAccess &&
					r.extractorTier !== "none",
			);
			if (blocked.length > 0) {
				fmt.error(
					`\n${blocked.length} source(s) require Full Disk Access. Grant it via System Settings → Privacy & Security → Full Disk Access, then add your terminal app to the list and re-run.`,
				);
			}
		});
	});

const initCommand = app
	.sub("init")
	.meta({
		description:
			"Auto-discover personal-data sources for the current OS (macOS: 30+ across iMessage, browsers, knowledge tools, calendars, mail, journals, code histories; Windows: Chrome/Firefox history, Obsidian, VSCode/Cursor workspaces, Claude Code sessions), register each with Nia, and (optionally) create a vault from them in one shot. The 'index my life' command.",
	})
	.flags({
		enable: {
			type: "string",
			description: `Comma-separated connectors to enable. Default: only sources marked auto_enable=true (the curated 'essential personal data' set). Pass 'all' to register every discovered source. Known connectors: ${ALL_CONNECTORS.join(", ")}.`,
		},
		all: {
			type: "boolean",
			description:
				"Register every discovered source regardless of auto_enable. Equivalent to --enable all, but easier to type.",
		},
		yes: {
			type: "boolean",
			description:
				"Skip the per-source confirmation prompt. Use this for fully autonomous agent flows.",
		},
		"dry-run": {
			type: "boolean",
			description:
				"Show what would be registered without actually calling the daemon endpoint.",
		},
		vault: {
			type: "string",
			description:
				"After registration, create a vault with this display name and seed it with all newly-registered sources. Triggers `nia vault init` automatically.",
		},
		"vault-description": {
			type: "string",
			description: "Optional description for the auto-created vault.",
		},
		"vault-model": {
			type: "string",
			description:
				"LLM model for the vault ingest workflow. Defaults to the backend default (claude-sonnet-4-5-1m, 1M context). Override with claude-opus-4-6-1m for higher quality.",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Personal" }, async () => {
			const enableList = parseEnableList(flags.enable as string | undefined);
			const enableAll =
				flags.all === true || (flags.enable as string | undefined) === "all";
			const dryRun = flags["dry-run"] === true;
			const skipConfirm = flags.yes === true || dryRun;

			const discovery = await discoverAll(flags["api-key"]);

			// Filter rules:
			// 1. extractorTier === "none" sources are NEVER registered (no backend support)
			// 2. If --enable is given (and not "all"), only those connectors
			// 3. Else if --all, every discovered source with extractorTier !== "none"
			// 4. Else (default), only sources with autoEnable === true
			// 5. Source must exist on disk and not already be registered
			const eligible = discovery.filter((r) => {
				if (r.extractorTier === "none") return false;
				if (enableList) {
					if (!enableList.includes(r.connector)) return false;
				} else if (!enableAll) {
					if (!r.autoEnable) return false;
				}
				if (!r.exists) return false;
				if (r.alreadyRegistered) return false;
				return true;
			});

			const blockedOnPermissions = eligible.filter((r) => !r.readable);
			const ready = eligible.filter((r) => r.readable);
			const alreadyRegistered = discovery.filter((r) => {
				if (!r.alreadyRegistered) return false;
				if (enableList) return enableList.includes(r.connector);
				if (enableAll) return true;
				return r.autoEnable;
			});

			// Print the discovery summary first so the user/agent sees what's about to happen.
			fmt.output({
				stage: "discovery",
				platform: process.platform,
				selection_mode: enableList
					? "explicit (--enable list)"
					: enableAll
						? "all (--all)"
						: "default (auto_enable=true sources only)",
				ready_to_register: ready.map((r) => ({
					connector: r.connector,
					display_name: r.displayName,
					tier: r.extractorTier,
					path: r.resolvedPath,
				})),
				already_registered: alreadyRegistered.map((r) => ({
					connector: r.connector,
					display_name: r.displayName,
					existing_source_id: r.existingSourceId,
				})),
				blocked_on_permissions: blockedOnPermissions.map((r) => ({
					connector: r.connector,
					display_name: r.displayName,
					path: r.resolvedPath,
					hint: "Grant Full Disk Access to your terminal app via System Settings → Privacy & Security → Full Disk Access.",
				})),
				not_found: discovery
					.filter(
						(r) =>
							r.extractorTier !== "none" &&
							!r.exists &&
							(enableList
								? enableList.includes(r.connector)
								: enableAll || r.autoEnable),
					)
					.map((r) => {
						const spec = PERSONAL_SOURCES.find(
							(s) => s.connector === r.connector,
						);
						const { discover, candidates } = spec
							? resolvePlatformSources(spec)
							: { discover: undefined, candidates: [] };
						return {
							connector: r.connector,
							display_name: r.displayName,
							searched: [
								...candidates,
								...(discover
									? ["(custom discovery callback found nothing)"]
									: []),
							],
						};
					}),
				roadmap_no_extractor_yet: discovery
					.filter((r) => r.extractorTier === "none" && r.exists)
					.map((r) => ({
						connector: r.connector,
						display_name: r.displayName,
						note: r.notes,
					})),
			});

			if (ready.length === 0 && alreadyRegistered.length === 0) {
				fmt.error(
					"\nNo personal data sources found to register. Run `nia personal status` to see the full landscape and what was probed.",
				);
				return;
			}

			if (!skipConfirm) {
				fmt.error(
					`\nAbout to register ${ready.length} source(s) with Nia. Re-run with --yes to confirm, or --dry-run to preview without writing.`,
				);
				return;
			}

			if (dryRun) {
				fmt.error(
					`\n[dry-run] Would register ${ready.length} source(s). No daemon calls made.`,
				);
				return;
			}

			// Register each ready source via the daemon endpoint.
			const registered: Array<{
				connector: string;
				source_id: string;
				display_name: string;
				path: string;
				tier: ExtractorTier;
			}> = [];
			const failed: Array<{
				connector: string;
				error: string;
			}> = [];

			for (const r of ready) {
				if (!r.resolvedPath || !r.dbType) continue;
				try {
					const result = await addLocalSource(
						r.resolvedPath,
						flags["api-key"],
						{
							// Use dbType (which is "folder" for folder-mode sources or the
							// connector key for SQLite sources) so the daemon dispatches
							// to the right extractor.
							detectedType: r.dbType,
							displayName: r.displayName,
						},
					);
					registered.push({
						connector: r.connector,
						source_id: result.local_folder_id,
						display_name: result.display_name ?? r.displayName,
						path: r.resolvedPath,
						tier: r.extractorTier,
					});
				} catch (err) {
					failed.push({
						connector: r.connector,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Build the source id list to seed a vault from. Includes both newly-
			// registered sources AND any pre-existing personal-data sources the
			// user already had — so chaining into `nia vault init` captures the
			// full set even on a re-run.
			const allPersonalSourceIds = [
				...registered.map((r) => r.source_id),
				...alreadyRegistered
					.map((r) => r.existingSourceId)
					.filter((id): id is string => Boolean(id)),
			];

			let vaultResult: Record<string, unknown> | null = null;
			let vaultError: string | null = null;
			if (flags.vault && allPersonalSourceIds.length > 0) {
				// Chain into vault creation. We do this via raw fetch instead of
				// importing the vault.ts handler to avoid circular dependencies and
				// to keep the personal command independent.
				try {
					await createSdk({ apiKey: flags["api-key"] });
					const baseUrl = await resolveBaseUrl();
					const token = OpenAPI.TOKEN;

					const createBody = {
						display_name: flags.vault,
						description:
							flags["vault-description"] ??
							`Auto-created from personal data sync on ${new Date().toISOString()}`,
						source_ids: allPersonalSourceIds,
					};
					const createResp = await fetch(`${baseUrl}/vaults`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(createBody),
					});
					if (!createResp.ok) {
						throw await createResponseError(
							createResp,
							"Vault creation failed",
						);
					}
					const created = (await createResp.json()) as Record<string, unknown>;
					const vaultId = created.id as string | undefined;

					// Trigger ingest in the background (will run with the new
					// 1M-context default model on the backend, or whatever the user
					// passed via --vault-model).
					if (vaultId) {
						try {
							const ingestBody: Record<string, unknown> = { mode: "ingest" };
							if (flags["vault-model"]) {
								ingestBody.model = flags["vault-model"];
							}
							await fetch(`${baseUrl}/vaults/${vaultId}/run`, {
								method: "POST",
								headers: {
									Authorization: `Bearer ${token}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify(ingestBody),
							});
						} catch (ingestErr) {
							// Non-fatal — vault exists, ingest just didn't kick off.
							vaultError = `Vault created but ingest trigger failed: ${ingestErr instanceof Error ? ingestErr.message : String(ingestErr)}. Run \`nia vault ingest ${vaultId}\` manually.`;
						}
					}
					vaultResult = created;
				} catch (err) {
					vaultError = err instanceof Error ? err.message : String(err);
				}
			}

			fmt.output({
				stage: "complete",
				registered,
				already_registered: alreadyRegistered.map((r) => ({
					connector: r.connector,
					source_id: r.existingSourceId,
				})),
				failed,
				vault: vaultResult,
				vault_error: vaultError,
				next_steps: [
					"Run an initial sync to populate the new sources: `nia local sync`",
					"For fire-and-forget background sync, install the LaunchAgent: `nia local install-watcher` (auto-runs `nia local watch` at every login).",
					"Vaults auto-refresh daily at 09:00 UTC by default (`vault_polling_workflow`). Toggle with `nia vault auto-sync <id> off`, or trigger immediately with `nia vault refresh <id>`.",
					ready.length > 0 && !flags.vault
						? `Create a vault from these sources: \`nia vault init "My Life" --from-source ${allPersonalSourceIds.join(",")}\``
						: null,
					vaultResult
						? `Vault created — poll status with \`nia vault info ${(vaultResult as { id?: string }).id}\``
						: null,
					blockedOnPermissions.length > 0
						? `${blockedOnPermissions.length} source(s) need Full Disk Access. Grant it via System Settings → Privacy & Security → Full Disk Access, then re-run \`nia personal init\`.`
						: null,
				].filter((x): x is string => Boolean(x)),
			});
		});
	});

const syncCommand = app
	.sub("sync")
	.meta({
		description:
			"Trigger a one-time sync for all registered personal-data sources. Equivalent to `nia local sync` but scoped to personal-data connectors only.",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Personal" }, async () => {
			// Delegate to the existing nia local sync via a hint message — implementing
			// a separate sync path here would duplicate the local syncer's batch
			// upload logic. The user is one short command away.
			fmt.output({
				message:
					"Run `nia local sync` to trigger a one-time sync of all registered local sources (including personal data). For continuous sync, run `nia local watch`.",
				next_commands: ["nia local sync", "nia local watch"],
			});
		});
	});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

export const personalCommand = annotate(
	app
		.sub("personal")
		.meta({
			description:
				"Index personal data into Nia in one command. On macOS, auto-discovers iMessage, Safari, Notes, Contacts, Reminders, Stickies, Voice Memos, and 20+ others. On Windows, auto-discovers Chrome/Firefox history, Obsidian vault, VSCode/Cursor workspaces, and Claude Code sessions. Registers each as a local-folder source.",
		})
		.command(initCommand)
		.command(statusCommand)
		.command(syncCommand),
	[
		"`nia personal init --yes` is the autonomous one-shot setup for personal data — on macOS it auto-discovers iMessage, Safari, Notes, Contacts, Reminders, Stickies, Voice Memos, and more; on Windows it auto-discovers Chrome/Firefox history, Obsidian vault, VSCode/Cursor workspaces, and Claude Code sessions. Registers each as a local-folder source.",
		"Add `--vault \"My Life\"` to chain into `nia vault init` automatically: discover → register → create vault → trigger ingest, all in one shell call. This is the 'index my life' command.",
		"Run `nia personal status` first to see what would be registered without writing anything. Use `--dry-run` on `init` for the same purpose.",
		"Some macOS sources (iMessage, Apple Notes, Contacts, etc.) require Full Disk Access. The CLI detects this and tells you exactly which ones need permission grants. Windows sources don't require FDA — the main gotcha is that Chrome must be quit before syncing its History DB.",
	],
);
