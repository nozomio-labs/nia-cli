import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { resolveApiKey, resolveBaseUrl } from "../config.ts";

/**
 * macOS launchd installer for `nia local watch`.
 *
 * Writes a per-user LaunchAgent at ~/Library/LaunchAgents/ai.nia.watch.plist,
 * loads it via `launchctl bootstrap gui/<uid>`, and verifies it's running.
 * The watcher then runs at every login and respawns automatically on crash.
 *
 * Why a LaunchAgent (not a LaunchDaemon): the watcher reads files in the
 * user's home folder, so it has to run as the user, not as root. LaunchAgents
 * also automatically pick up the user's environment scope (TCC permissions
 * granted to the user, not system-wide).
 */

export const LAUNCHD_LABEL = "ai.nia.watch";
export const LAUNCHD_PLIST_FILENAME = `${LAUNCHD_LABEL}.plist`;

export interface WatcherInstallOptions {
	apiKey?: string;
	apiUrl?: string;
	niaBinaryPath?: string;
	debounceMs?: number;
	refreshSeconds?: number;
	fallbackSeconds?: number;
}

export interface WatcherInstallResult {
	plist_path: string;
	label: string;
	nia_binary_path: string;
	stdout_log: string;
	stderr_log: string;
	loaded: boolean;
	pid?: number;
	already_loaded?: boolean;
	message?: string;
}

export interface WatcherStatusResult {
	installed: boolean;
	loaded: boolean;
	plist_path: string;
	pid?: number;
	last_exit_status?: number;
	stdout_log_exists?: boolean;
	stderr_log_exists?: boolean;
	stderr_tail?: string;
	stdout_tail?: string;
}

export function isMacos(): boolean {
	return platform() === "darwin";
}

export function plistPath(): string {
	return path.join(
		homedir(),
		"Library",
		"LaunchAgents",
		LAUNCHD_PLIST_FILENAME,
	);
}

export function logDir(): string {
	return path.join(homedir(), "Library", "Logs", "nia");
}

function stdoutLogPath(): string {
	return path.join(logDir(), "watch.out.log");
}

function stderrLogPath(): string {
	return path.join(logDir(), "watch.err.log");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function getCurrentUid(): number {
	const uid = process.getuid?.();
	if (typeof uid !== "number") {
		throw new Error(
			"Cannot determine current user id (process.getuid not available)",
		);
	}
	return uid;
}

function whichNia(): string | null {
	try {
		const out = execSync("command -v nia 2>/dev/null", {
			encoding: "utf8",
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

function resolveNiaBinary(override?: string): string {
	if (override) {
		const resolved = path.resolve(override);
		if (!existsSync(resolved)) {
			throw new Error(`nia binary override does not exist: ${resolved}`);
		}
		return resolved;
	}
	const found = whichNia();
	if (found) return found;
	throw new Error(
		"Could not locate `nia` in PATH. Re-install via `npm i -g @nozomioai/nia` or pass --nia-path /absolute/path/to/nia.",
	);
}

function buildPlist(opts: {
	niaBinary: string;
	apiKey: string;
	apiUrl: string;
	debounceMs: number;
	refreshSeconds: number;
	fallbackSeconds: number;
}): string {
	const args: string[] = [
		opts.niaBinary,
		"local",
		"watch",
		"--debounce-ms",
		String(opts.debounceMs),
		"--refresh-seconds",
		String(opts.refreshSeconds),
		"--fallback-seconds",
		String(opts.fallbackSeconds),
	];
	const argsXml = args
		.map((arg) => `\t\t<string>${escapeXml(arg)}</string>`)
		.join("\n");
	// PATH must include common Homebrew + Bun install dirs so the spawned shell
	// can find any tools the watcher invokes (and for symlink resolution on
	// `nia` itself when installed via brew/asdf/volta).
	const envPath = [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
		`${homedir()}/.bun/bin`,
		`${homedir()}/.npm-global/bin`,
		`${homedir()}/.local/bin`,
	].join(":");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(LAUNCHD_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>NIA_API_KEY</key>
\t\t<string>${escapeXml(opts.apiKey)}</string>
\t\t<key>NIA_BASE_URL</key>
\t\t<string>${escapeXml(opts.apiUrl)}</string>
\t\t<key>HOME</key>
\t\t<string>${escapeXml(homedir())}</string>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(envPath)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t\t<key>Crashed</key>
\t\t<true/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(stdoutLogPath())}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(stderrLogPath())}</string>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(homedir())}</string>
\t<key>ProcessType</key>
\t<string>Background</string>
</dict>
</plist>
`;
}

function launchctlPrint(label: string): string | null {
	try {
		const uid = getCurrentUid();
		return execSync(`launchctl print gui/${uid}/${label} 2>&1`, {
			encoding: "utf8",
		});
	} catch (err) {
		// `launchctl print` exits non-zero if the service isn't loaded
		const stdout = (err as { stdout?: Buffer | string }).stdout;
		if (stdout) {
			return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
		}
		return null;
	}
}

function isServiceLoaded(): boolean {
	const out = launchctlPrint(LAUNCHD_LABEL);
	if (!out) return false;
	return !out.includes("Could not find service");
}

function parsePidFromPrint(output: string | null): number | undefined {
	if (!output) return undefined;
	const match = output.match(/^\s*pid\s*=\s*(\d+)/m);
	if (match) return Number(match[1]);
	return undefined;
}

function parseLastExitFromPrint(output: string | null): number | undefined {
	if (!output) return undefined;
	const match = output.match(/^\s*last exit (?:code|reason)\s*=\s*(-?\d+)/m);
	if (match) return Number(match[1]);
	return undefined;
}

function bootoutService(): void {
	const uid = getCurrentUid();
	try {
		execSync(`launchctl bootout gui/${uid}/${LAUNCHD_LABEL} 2>/dev/null`, {
			stdio: "pipe",
		});
	} catch {
		// already unloaded — fine
	}
	// launchctl bootout returns before launchd has fully torn down the
	// service descriptor; if we bootstrap immediately we get
	// "Bootstrap failed: 5: Input/output error". Poll until `print` confirms
	// the service is gone (max ~3s).
	for (let i = 0; i < 30; i++) {
		if (!isServiceLoaded()) return;
		execSync("sleep 0.1");
	}
}

function bootstrapService(plistAbsPath: string): void {
	const uid = getCurrentUid();
	// `launchctl bootstrap` occasionally returns EIO (5) immediately after a
	// bootout because launchd is still tearing down the old service descriptor.
	// Retry a few times with backoff before giving up.
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			execSync(
				`launchctl bootstrap gui/${uid} ${JSON.stringify(plistAbsPath)}`,
				{ stdio: "pipe" },
			);
			lastErr = null;
			break;
		} catch (err) {
			lastErr = err;
			execSync("sleep 0.5");
		}
	}
	if (lastErr) throw lastErr;

	try {
		execSync(`launchctl enable gui/${uid}/${LAUNCHD_LABEL}`, { stdio: "pipe" });
	} catch {
		// `enable` is best-effort — bootstrap already loaded the service
	}
	try {
		execSync(`launchctl kickstart -k gui/${uid}/${LAUNCHD_LABEL}`, {
			stdio: "pipe",
		});
	} catch {
		// `kickstart` is best-effort — RunAtLoad will start it on next login otherwise
	}
}

export async function installWatcher(
	options: WatcherInstallOptions = {},
): Promise<WatcherInstallResult> {
	if (!isMacos()) {
		throw new Error(
			"install-watcher is only supported on macOS. On Linux, run `nia local watch` under systemd / supervisord.",
		);
	}

	const apiKey = await resolveApiKey(options.apiKey);
	if (!apiKey) {
		throw new Error(
			"No API key found. Run `nia auth login` first or pass --api-key.",
		);
	}
	const apiUrl = await resolveBaseUrl(options.apiUrl);
	const niaBinary = resolveNiaBinary(options.niaBinaryPath);

	const debounceMs = options.debounceMs ?? 2000;
	const refreshSeconds = options.refreshSeconds ?? 30;
	const fallbackSeconds = options.fallbackSeconds ?? 600;

	mkdirSync(logDir(), { recursive: true });
	mkdirSync(path.dirname(plistPath()), { recursive: true });

	const plistContents = buildPlist({
		niaBinary,
		apiKey,
		apiUrl,
		debounceMs,
		refreshSeconds,
		fallbackSeconds,
	});

	// Bootout any existing copy first so re-installs pick up the new contents
	// (launchd reads the plist once at bootstrap time and caches it).
	const wasLoaded = isServiceLoaded();
	if (wasLoaded) {
		bootoutService();
	}

	writeFileSync(plistPath(), plistContents, "utf8");
	chmodSync(plistPath(), 0o644);

	bootstrapService(plistPath());

	const printOut = launchctlPrint(LAUNCHD_LABEL);
	const loaded = !!printOut && !printOut.includes("Could not find service");
	const pid = parsePidFromPrint(printOut);

	return {
		plist_path: plistPath(),
		label: LAUNCHD_LABEL,
		nia_binary_path: niaBinary,
		stdout_log: stdoutLogPath(),
		stderr_log: stderrLogPath(),
		loaded,
		pid,
		already_loaded: wasLoaded,
		message: loaded
			? "Watcher loaded — `nia local watch` will run on every login and auto-restart on crash."
			: "Plist written but launchctl could not confirm load. Check the stderr log.",
	};
}

export function uninstallWatcher(): {
	plist_path: string;
	removed: boolean;
	was_loaded: boolean;
} {
	if (!isMacos()) {
		throw new Error("install-watcher is only supported on macOS.");
	}
	const wasLoaded = isServiceLoaded();
	bootoutService();
	let removed = false;
	if (existsSync(plistPath())) {
		rmSync(plistPath());
		removed = true;
	}
	return { plist_path: plistPath(), removed, was_loaded: wasLoaded };
}

function tail(file: string, lines: number): string | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const text = readFileSync(file, "utf8");
		const split = text.split("\n");
		return split.slice(-lines).join("\n");
	} catch {
		return undefined;
	}
}

export function watcherStatus(): WatcherStatusResult {
	if (!isMacos()) {
		throw new Error("install-watcher is only supported on macOS.");
	}
	const installed = existsSync(plistPath());
	const printOut = launchctlPrint(LAUNCHD_LABEL);
	const loaded = !!printOut && !printOut.includes("Could not find service");
	return {
		installed,
		loaded,
		plist_path: plistPath(),
		pid: parsePidFromPrint(printOut),
		last_exit_status: parseLastExitFromPrint(printOut),
		stdout_log_exists: existsSync(stdoutLogPath()),
		stderr_log_exists: existsSync(stderrLogPath()),
		stderr_tail: tail(stderrLogPath(), 20),
		stdout_tail: tail(stdoutLogPath(), 20),
	};
}
