import {
	accessSync,
	existsSync,
	constants as fsConstants,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import {
	addLocalSource,
	enableLocalSourceSync,
	listLocalSources,
	removeLocalSource,
} from "../services/local/api.ts";
import { TYPE_FOLDER } from "../services/local/extractor.ts";
import { syncLocalSource, syncLocalSources } from "../services/local/sync.ts";
import type {
	LocalSource,
	LocalSourceStatus,
} from "../services/local/types.ts";
import { LocalFolderWatcher } from "../services/local/watcher.ts";
import {
	installWatcher,
	uninstallWatcher,
	watcherStatus,
} from "../services/local/watcher-install.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

function validateDirectory(inputPath: string): string {
	const resolved = path.resolve(inputPath);
	if (!existsSync(resolved)) {
		throw new Error(`Path does not exist: ${resolved}`);
	}
	if (!statSync(resolved).isDirectory()) {
		throw new Error(`Path is not a directory: ${resolved}`);
	}
	return resolved;
}

export function resolveLocalSource(
	sources: LocalSource[],
	identifier: string,
): LocalSource {
	const exact = sources.find((source) => source.local_folder_id === identifier);
	if (exact) {
		return exact;
	}

	const matches = sources.filter((source) =>
		source.local_folder_id.startsWith(identifier),
	);
	if (matches.length === 0) {
		throw new Error(`Local source not found: ${identifier}`);
	}
	if (matches.length > 1) {
		const options = matches
			.slice(0, 5)
			.map((source) => source.local_folder_id.slice(0, 8))
			.join(", ");
		throw new Error(
			`Ambiguous local source ID prefix: ${identifier}. Matches: ${options}`,
		);
	}

	const match = matches[0];
	if (!match) {
		throw new Error(`Local source not found: ${identifier}`);
	}
	return match;
}

export function buildLocalSourceStatuses(
	sources: LocalSource[],
): LocalSourceStatus[] {
	return sources.map((source) => {
		const sourcePath = source.path ?? "";
		let status: LocalSourceStatus["status"] = "needs_link";
		if (sourcePath) {
			status = existsSync(path.resolve(sourcePath))
				? "ready"
				: "path_not_found";
		}

		return {
			id: source.local_folder_id,
			name: source.display_name ?? "(unnamed)",
			path: sourcePath,
			type: source.detected_type ?? TYPE_FOLDER,
			status,
		};
	});
}

function filterFolderSources(sources: LocalSource[]): LocalSource[] {
	// Sync handles two extraction paths:
	//   - detected_type === "folder" (or unset): generic directory walker
	//   - detected_type === <connector key>: SQLite extractor (Apple Notes,
	//     Books, Anki, Screen Time, etc.) via the bun:sqlite path in extractor.ts
	// Both paths are dispatched in syncLocalSource, so we no longer filter
	// SQLite/personal-data sources out here.
	return sources.filter((source) => Boolean(source.detected_type));
}

function isReadySource(source: LocalSource): boolean {
	return Boolean(source.path && existsSync(path.resolve(source.path)));
}

function formatSyncResult(
	result: Awaited<ReturnType<typeof syncLocalSource>>,
): string {
	if (result.status === "success") {
		if ((result.added ?? 0) > 0) {
			return `${result.path} - ${result.added} items synced`;
		}
		return `${result.path} - ${result.message ?? "No new data"}`;
	}
	if (result.status === "skipped") {
		return `${result.path ?? "(unlinked)"} - ${result.message ?? "Skipped"}`;
	}
	return `${result.path ?? "(unknown)"} - ${result.error ?? "Unknown error"}`;
}

async function runWatchLoop(options: {
	apiKey?: string;
	debounceMs: number;
	refreshSeconds: number;
	fallbackSeconds: number;
	targetId?: string;
}): Promise<void> {
	const watcher = new LocalFolderWatcher(options.debounceMs);
	const pending = new Set<string>();
	const lastSyncedAt = new Map<string, number>();
	let sourceMap = new Map<string, LocalSource>();
	let running = true;

	const onChange = (sourceId: string) => {
		pending.add(sourceId);
	};

	const updateSources = async (): Promise<void> => {
		const current = filterFolderSources(await listLocalSources(options.apiKey));
		let next = current;
		if (options.targetId) {
			next = [resolveLocalSource(current, options.targetId)];
		}

		const nextMap = new Map(
			next.map((source) => [source.local_folder_id, source]),
		);
		for (const sourceId of watcher.watching) {
			const source = nextMap.get(sourceId);
			if (!source || !isReadySource(source)) {
				await watcher.unwatch(sourceId);
			}
		}

		for (const source of next) {
			if (!isReadySource(source)) {
				continue;
			}
			if (!watcher.watching.includes(source.local_folder_id)) {
				watcher.watch(
					source.local_folder_id,
					path.resolve(source.path ?? ""),
					onChange,
				);
			}
		}

		sourceMap = nextMap;
	};

	const drainPending = async (): Promise<void> => {
		const targets = Array.from(pending);
		pending.clear();

		for (const sourceId of targets) {
			const source = sourceMap.get(sourceId);
			if (!source) {
				continue;
			}
			const result = await syncLocalSource(source, { apiKey: options.apiKey });
			lastSyncedAt.set(sourceId, Date.now());
			console.log(formatSyncResult(result));
		}
	};

	const stop = () => {
		running = false;
	};

	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		await updateSources();
		for (const sourceId of watcher.watching) {
			pending.add(sourceId);
		}
		await drainPending();

		let lastRefreshAt = Date.now();
		while (running) {
			await drainPending();

			const now = Date.now();
			if (now - lastRefreshAt >= options.refreshSeconds * 1000) {
				await updateSources();
				lastRefreshAt = now;
			}

			for (const sourceId of watcher.watching) {
				const lastSync = lastSyncedAt.get(sourceId) ?? 0;
				if (now - lastSync >= options.fallbackSeconds * 1000) {
					pending.add(sourceId);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await watcher.stop();
	}
}

const addCommand = app
	.sub("add")
	.meta({ description: "Add a local folder source" })
	.args([
		{
			name: "path",
			type: "string",
			description: "Folder path to sync",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Local sync" }, async () => {
			const folderPath = validateDirectory(args.path);
			const result = await addLocalSource(folderPath, flags["api-key"]);
			fmt.output({
				id: result.local_folder_id,
				name: result.display_name ?? path.basename(folderPath),
				path: folderPath,
				next: `nia local sync ${result.local_folder_id}`,
			});
		});
	});

const statusCommand = app
	.sub("status")
	.meta({ description: "List local folder sync sources and status" })
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Local sync" }, async () => {
			const sources = await listLocalSources(flags["api-key"]);
			const rows = buildLocalSourceStatuses(sources);
			fmt.output(rows, {
				columns: ["id", "name", "path", "type", "status"],
			});
		});
	});

const linkCommand = app
	.sub("link")
	.meta({ description: "Link an existing local source to a folder path" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Local source ID or unique prefix",
			required: true,
		},
		{
			name: "path",
			type: "string",
			description: "Folder path to link",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Local sync" }, async () => {
			const folderPath = validateDirectory(args.path);
			const sources = await listLocalSources(flags["api-key"]);
			const source = resolveLocalSource(sources, args.id);
			await enableLocalSourceSync(
				source.local_folder_id,
				folderPath,
				flags["api-key"],
			);
			console.log(
				`Linked ${source.display_name ?? source.local_folder_id} -> ${folderPath}`,
			);
		});
	});

const removeCommand = app
	.sub("remove")
	.meta({ description: "Remove a local sync source" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Local source ID or unique prefix",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Local sync" }, async () => {
			const sources = await listLocalSources(flags["api-key"]);
			const source = resolveLocalSource(sources, args.id);
			await removeLocalSource(source.local_folder_id, flags["api-key"]);
			console.log(`Removed ${source.display_name ?? source.local_folder_id}`);
		});
	});

const syncCommand = app
	.sub("sync")
	.meta({ description: "Run a one-time local folder sync" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Optional local source ID or unique prefix",
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Local sync" }, async () => {
			let sources = filterFolderSources(
				await listLocalSources(flags["api-key"]),
			);
			if (args.id) {
				sources = [resolveLocalSource(sources, args.id)];
			}

			const results = await syncLocalSources(sources, {
				apiKey: flags["api-key"],
			});
			for (const result of results) {
				console.log(formatSyncResult(result));
			}
		});
	});

const watchCommand = app
	.sub("watch")
	.meta({ description: "Watch local folders and sync changes continuously" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Optional local source ID or unique prefix",
		},
	] as const)
	.flags({
		"debounce-ms": {
			type: "number",
			description: "Debounce window for file changes (default: 2000)",
		},
		"refresh-seconds": {
			type: "number",
			description: "Refresh source list interval (default: 30)",
		},
		"fallback-seconds": {
			type: "number",
			description: "Fallback sync interval (default: 600)",
		},
	})
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Local sync" }, async () => {
			const sources = filterFolderSources(
				await listLocalSources(flags["api-key"]),
			);
			if (sources.length === 0) {
				console.log("No local folder sources found.");
				return;
			}

			await runWatchLoop({
				apiKey: flags["api-key"],
				debounceMs: flags["debounce-ms"] ?? 2000,
				refreshSeconds: flags["refresh-seconds"] ?? 30,
				fallbackSeconds: flags["fallback-seconds"] ?? 600,
				targetId: args.id,
			});
		});
	});

const installWatcherCommand = app
	.sub("install-watcher")
	.meta({
		description:
			"Install a macOS LaunchAgent that runs `nia local watch` at every login and auto-restarts on crash. After this, your local sources stay fresh in the background without you running anything.",
	})
	.flags({
		"nia-path": {
			type: "string",
			description: "Override path to the `nia` binary (default: `which nia`)",
		},
		"debounce-ms": {
			type: "number",
			description: "Debounce window for file changes (default: 2000)",
		},
		"refresh-seconds": {
			type: "number",
			description: "Refresh source list interval (default: 30)",
		},
		"fallback-seconds": {
			type: "number",
			description: "Fallback sync interval (default: 600)",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Watcher install" }, async () => {
			const result = await installWatcher({
				apiKey: flags["api-key"],
				niaBinaryPath: flags["nia-path"],
				debounceMs: flags["debounce-ms"],
				refreshSeconds: flags["refresh-seconds"],
				fallbackSeconds: flags["fallback-seconds"],
			});
			fmt.output({
				stage: "installed",
				...result,
				next_commands: [
					"nia local watcher-status",
					"tail -f ~/Library/Logs/nia/watch.err.log",
					"nia local uninstall-watcher",
				],
			});
		});
	});

const uninstallWatcherCommand = app
	.sub("uninstall-watcher")
	.meta({
		description:
			"Stop and remove the `nia local watch` LaunchAgent installed by `install-watcher`.",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Watcher uninstall" }, async () => {
			const result = uninstallWatcher();
			fmt.output({ stage: "uninstalled", ...result });
		});
	});

const watcherStatusCommand = app
	.sub("watcher-status")
	.meta({
		description:
			"Show the status of the `nia local watch` LaunchAgent (loaded, pid, last exit, log tail).",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});
		await withErrorHandling({ domain: "Watcher status" }, async () => {
			fmt.output(watcherStatus());
		});
	});

const DOCTOR_PATHS: Record<string, string> = {
	imessage: path.join(homedir(), "Library/Messages/chat.db"),
	safari_history: path.join(homedir(), "Library/Safari/History.db"),
	chrome_history: path.join(
		homedir(),
		"Library/Application Support/Google/Chrome/Default/History",
	),
	whatsapp: path.join(
		homedir(),
		"Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
	),
	notes: path.join(
		homedir(),
		"Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
	),
	screen_time: path.join(
		homedir(),
		"Library/Application Support/Knowledge/knowledgeC.db",
	),
	photos: path.join(
		homedir(),
		"Pictures/Photos Library.photoslibrary/database/Photos.sqlite",
	),
	podcasts: path.join(
		homedir(),
		"Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite",
	),
};

const doctorCommand = app
	.sub("doctor")
	.meta({ description: "Run diagnostics for local data source access" })
	.run(async ({ flags }) => {
		const fmt = createOutput({
			color: flags.color,
			json: flags.json,
			output: flags.output,
		});

		await withErrorHandling({ domain: "Doctor" }, async () => {
			const checks: Array<{ source: string; status: string; detail: string }> =
				[];

			try {
				const sources = await listLocalSources(flags["api-key"]);
				checks.push({
					source: "API",
					status: "OK",
					detail: `${sources.length} source(s) found`,
				});
			} catch (err) {
				checks.push({
					source: "API",
					status: "FAIL",
					detail: err instanceof Error ? err.message : "Connection failed",
				});
			}

			for (const [name, dbPath] of Object.entries(DOCTOR_PATHS)) {
				if (!existsSync(dbPath)) {
					checks.push({
						source: name,
						status: "SKIP",
						detail: "Not installed",
					});
					continue;
				}
				try {
					accessSync(dbPath, fsConstants.R_OK);
					checks.push({ source: name, status: "OK", detail: dbPath });
				} catch {
					checks.push({
						source: name,
						status: "FAIL",
						detail: "Permission denied — grant Full Disk Access",
					});
				}
			}

			fmt.output(checks);
		});
	});

export const localCommand = annotate(
	app
		.sub("local")
		.meta({ description: "Manage and sync local folder sources" })
		.command(addCommand)
		.command(statusCommand)
		.command(linkCommand)
		.command(removeCommand)
		.command(syncCommand)
		.command(watchCommand)
		.command(installWatcherCommand)
		.command(uninstallWatcherCommand)
		.command(watcherStatusCommand)
		.command(doctorCommand),
	[
		"Use `nia local add <path>` to register a folder and `nia local sync` for a one-time push.",
		"Use `nia local watch` to keep linked folders synced continuously.",
		"Run `nia local install-watcher` once to start `nia local watch` automatically at every login via a macOS LaunchAgent — this is the 'fire and forget' background sync mode for keeping vaults fresh.",
		"Target a source by full ID or a unique ID prefix for link, remove, sync, and watch.",
	],
);
