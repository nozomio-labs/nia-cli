import chokidar, { type FSWatcher } from "chokidar";

export class LocalFolderWatcher {
	private readonly debounceMs: number;
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(debounceMs = 2000) {
		this.debounceMs = debounceMs;
	}

	watch(
		sourceId: string,
		folderPath: string,
		onChange: (sourceId: string) => void,
	): boolean {
		if (this.watchers.has(sourceId)) {
			return true;
		}

		try {
			const watcher = chokidar.watch(folderPath, {
				ignoreInitial: true,
				// Skip directories the user can't read (TCC-protected paths like
				// ~/Library/Calendars even when Full Disk Access is granted to
				// the parent process — chokidar would otherwise log a torrent of
				// EPERM lstat errors and pollute the LaunchAgent stderr log).
				ignorePermissionErrors: true,
				awaitWriteFinish: {
					stabilityThreshold: 500,
					pollInterval: 100,
				},
			});

			const trigger = () => {
				const existing = this.timers.get(sourceId);
				if (existing) {
					clearTimeout(existing);
				}
				const timer = setTimeout(() => {
					this.timers.delete(sourceId);
					onChange(sourceId);
				}, this.debounceMs);
				this.timers.set(sourceId, timer);
			};

			watcher.on("add", trigger);
			watcher.on("change", trigger);
			watcher.on("unlink", trigger);
			// Swallow chokidar error events so a single unreadable directory
			// (EPERM/ENOENT) doesn't kill the watcher or spam stderr. The
			// fallback periodic sync still picks up changes from sibling dirs.
			watcher.on("error", () => {});

			this.watchers.set(sourceId, watcher);
			return true;
		} catch {
			return false;
		}
	}

	async unwatch(sourceId: string): Promise<void> {
		const timer = this.timers.get(sourceId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(sourceId);
		}

		const watcher = this.watchers.get(sourceId);
		if (!watcher) {
			return;
		}

		this.watchers.delete(sourceId);
		await watcher.close();
	}

	async stop(): Promise<void> {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		const closes = Array.from(this.watchers.values()).map((watcher) =>
			watcher.close(),
		);
		this.watchers.clear();
		await Promise.all(closes);
	}

	get watching(): string[] {
		return Array.from(this.watchers.keys());
	}
}
