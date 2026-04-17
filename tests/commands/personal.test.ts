import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	discoverChromeHistoryWindows,
	discoverCursorWorkspaceStorageWindows,
	discoverFirefoxProfileWindows,
	discoverObsidianVaultWindows,
	discoverPath,
	discoverPowerShellHistoryWindows,
	discoverVSCodeWorkspaceStorageWindows,
	discoverWindowsTimeline,
	isApplicableToCurrentPlatform,
	PERSONAL_SOURCES,
	type PersonalSourceSpec,
	resolvePlatformSources,
} from "../../src/commands/personal.ts";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function makeSpec(
	overrides: Partial<PersonalSourceSpec> = {},
): PersonalSourceSpec {
	return {
		connector: "test",
		displayName: "Test",
		description: "Test spec",
		macosCandidates: [],
		requiresFullDiskAccess: false,
		extractorTier: "folder",
		dbType: "folder",
		autoEnable: false,
		...overrides,
	};
}

describe("isApplicableToCurrentPlatform", () => {
	test("defaults to darwin when platforms is omitted", () => {
		const spec = makeSpec();
		expect(isApplicableToCurrentPlatform(spec)).toBe(isMac);
	});

	test("respects an explicit platforms list", () => {
		const darwinOnly = makeSpec({ platforms: ["darwin"] });
		const windowsOnly = makeSpec({ platforms: ["win32"] });
		const both = makeSpec({ platforms: ["darwin", "win32"] });

		expect(isApplicableToCurrentPlatform(darwinOnly)).toBe(isMac);
		expect(isApplicableToCurrentPlatform(windowsOnly)).toBe(isWindows);
		expect(isApplicableToCurrentPlatform(both)).toBe(isMac || isWindows);
	});
});

describe("resolvePlatformSources", () => {
	test("returns the platform-appropriate candidates + discover", () => {
		const macDiscover = () => "/mac/path";
		const winDiscover = () => "C:\\win\\path";
		const spec = makeSpec({
			macosCandidates: ["/mac/a", "/mac/b"],
			windowsCandidates: ["C:\\win\\a"],
			discover: macDiscover,
			discoverWindows: winDiscover,
		});

		const resolved = resolvePlatformSources(spec);
		if (isWindows) {
			expect(resolved.candidates).toEqual(["C:\\win\\a"]);
			expect(resolved.discover).toBe(winDiscover);
		} else {
			expect(resolved.candidates).toEqual(["/mac/a", "/mac/b"]);
			expect(resolved.discover).toBe(macDiscover);
		}
	});

	test("windowsCandidates defaults to empty array when not set", () => {
		const spec = makeSpec({ macosCandidates: ["/x"] });
		const resolved = resolvePlatformSources(spec);
		if (isWindows) {
			expect(resolved.candidates).toEqual([]);
			expect(resolved.discover).toBeUndefined();
		}
	});
});

describe("discoverPath", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("finds a real path via the current-platform static candidates", () => {
		tempDir = path.join(os.tmpdir(), `nia-personal-static-${Date.now()}`);
		const target = path.join(tempDir, "data");
		mkdirSync(target, { recursive: true });

		const spec: PersonalSourceSpec = isWindows
			? makeSpec({
					platforms: ["win32"],
					windowsCandidates: [target],
				})
			: makeSpec({
					platforms: ["darwin"],
					macosCandidates: [target],
				});

		const result = discoverPath(spec);
		expect(result.exists).toBe(true);
		expect(result.resolvedPath).toBe(target);
		expect(result.readable).toBe(true);
	});

	test("prefers the platform-specific discover callback over static candidates", () => {
		tempDir = path.join(os.tmpdir(), `nia-personal-discover-${Date.now()}`);
		const discovered = path.join(tempDir, "discovered");
		const fallback = path.join(tempDir, "fallback");
		mkdirSync(discovered, { recursive: true });
		mkdirSync(fallback, { recursive: true });

		const spec: PersonalSourceSpec = isWindows
			? makeSpec({
					platforms: ["win32"],
					windowsCandidates: [fallback],
					discoverWindows: () => discovered,
				})
			: makeSpec({
					platforms: ["darwin"],
					macosCandidates: [fallback],
					discover: () => discovered,
				});

		expect(discoverPath(spec).resolvedPath).toBe(discovered);
	});

	test("returns not-found when no candidate exists", () => {
		const spec = makeSpec({
			platforms: [process.platform as "darwin" | "win32" | "linux"],
			macosCandidates: ["/definitely/does/not/exist"],
			windowsCandidates: ["Z:\\also\\not\\there"],
		});
		const result = discoverPath(spec);
		expect(result.exists).toBe(false);
		expect(result.resolvedPath).toBeNull();
	});

	test("falls back to static candidates when discover throws", () => {
		tempDir = path.join(os.tmpdir(), `nia-personal-throw-${Date.now()}`);
		const target = path.join(tempDir, "fallback");
		mkdirSync(target, { recursive: true });

		const thrower = () => {
			throw new Error("boom");
		};
		const spec: PersonalSourceSpec = isWindows
			? makeSpec({
					platforms: ["win32"],
					windowsCandidates: [target],
					discoverWindows: thrower,
				})
			: makeSpec({
					platforms: ["darwin"],
					macosCandidates: [target],
					discover: thrower,
				});

		expect(discoverPath(spec).resolvedPath).toBe(target);
	});
});

describe("catalog Windows tagging", () => {
	const windowsBacked = [
		"chrome_history",
		"firefox_history",
		"obsidian",
		"vscode_workspaces",
		"cursor_workspaces",
		"claude_code_history",
	];

	test("every targeted connector is tagged for win32 + darwin", () => {
		for (const connector of windowsBacked) {
			const spec = PERSONAL_SOURCES.find((s) => s.connector === connector);
			expect(spec).toBeDefined();
			expect(spec?.platforms).toEqual(["darwin", "win32"]);
		}
	});

	test("every targeted connector has Windows discovery wired", () => {
		for (const connector of windowsBacked) {
			const spec = PERSONAL_SOURCES.find((s) => s.connector === connector);
			const hasWindowsPath =
				(spec?.windowsCandidates?.length ?? 0) > 0 ||
				typeof spec?.discoverWindows === "function";
			expect(hasWindowsPath).toBe(true);
		}
	});

	test("untagged connectors remain macOS-only (default platform)", () => {
		const iMessage = PERSONAL_SOURCES.find((s) => s.connector === "imessage");
		expect(iMessage).toBeDefined();
		expect(iMessage?.platforms).toBeUndefined();
		expect(iMessage?.windowsCandidates).toBeUndefined();
		expect(iMessage?.discoverWindows).toBeUndefined();
	});
});

describe("catalog Windows-exclusive sources", () => {
	const windowsOnly = ["windows_timeline", "powershell_history"] as const;

	test("each is tagged win32-only and has Windows discovery wired", () => {
		for (const connector of windowsOnly) {
			const spec = PERSONAL_SOURCES.find((s) => s.connector === connector);
			expect(spec).toBeDefined();
			expect(spec?.platforms).toEqual(["win32"]);
			expect(typeof spec?.discoverWindows).toBe("function");
			// No macOS side: empty candidates and no discover callback.
			expect(spec?.macosCandidates).toEqual([]);
			expect(spec?.discover).toBeUndefined();
		}
	});

	test("windows_timeline is generic-tier with schema-unaware dbType", () => {
		const spec = PERSONAL_SOURCES.find(
			(s) => s.connector === "windows_timeline",
		);
		expect(spec?.extractorTier).toBe("generic");
		expect(spec?.dbType).toBe("windows_timeline");
		// Off by default — generic walker output is noisy.
		expect(spec?.autoEnable).toBe(false);
	});

	test("powershell_history is folder-tier and off by default", () => {
		const spec = PERSONAL_SOURCES.find(
			(s) => s.connector === "powershell_history",
		);
		expect(spec?.extractorTier).toBe("folder");
		expect(spec?.dbType).toBe("folder");
		// Off by default — shell history can leak pasted secrets.
		expect(spec?.autoEnable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Windows-only env-var-driven discovery helpers
// ---------------------------------------------------------------------------
//
// These read LOCALAPPDATA / APPDATA at call time, so we can override them with
// a tmp dir per test. Skipped on non-Windows because the helpers look up real
// Windows env vars — the behavior under a simulated env is identical to
// running on Windows, but CI matrix OSes may interpret backslash paths
// differently, so we keep it simple.

describe.skipIf(!isWindows)("Windows discovery helpers", () => {
	let tempDir: string;
	const originalLocal = process.env.LOCALAPPDATA;
	const originalRoaming = process.env.APPDATA;
	const originalUserProfile = process.env.USERPROFILE;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `nia-personal-winhelpers-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		process.env.LOCALAPPDATA = path.join(tempDir, "Local");
		process.env.APPDATA = path.join(tempDir, "Roaming");
		// os.homedir() reads USERPROFILE on Windows. Point it at our temp dir
		// so the Obsidian discovery (which uses homedir(), not LOCALAPPDATA)
		// can be exercised hermetically.
		process.env.USERPROFILE = path.join(tempDir, "Home");
		mkdirSync(process.env.USERPROFILE, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalLocal !== undefined) process.env.LOCALAPPDATA = originalLocal;
		else delete process.env.LOCALAPPDATA;
		if (originalRoaming !== undefined) process.env.APPDATA = originalRoaming;
		else delete process.env.APPDATA;
		if (originalUserProfile !== undefined)
			process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
	});

	test("Chrome history — Default profile wins over Profile N", () => {
		const userData = path.join(
			process.env.LOCALAPPDATA as string,
			"Google",
			"Chrome",
			"User Data",
		);
		mkdirSync(path.join(userData, "Default"), { recursive: true });
		mkdirSync(path.join(userData, "Profile 1"), { recursive: true });
		writeFileSync(path.join(userData, "Default", "History"), "");
		writeFileSync(path.join(userData, "Profile 1", "History"), "");

		const resolved = discoverChromeHistoryWindows();
		expect(resolved).toBe(path.join(userData, "Default", "History"));
	});

	test("Chrome history — falls back to first Profile N when Default missing", () => {
		const userData = path.join(
			process.env.LOCALAPPDATA as string,
			"Google",
			"Chrome",
			"User Data",
		);
		mkdirSync(path.join(userData, "Profile 1"), { recursive: true });
		writeFileSync(path.join(userData, "Profile 1", "History"), "");

		const resolved = discoverChromeHistoryWindows();
		expect(resolved).toBe(path.join(userData, "Profile 1", "History"));
	});

	test("Chrome history — picks Profile 1 over Profile 2/Profile 10 (sorted, not readdir order)", () => {
		const userData = path.join(
			process.env.LOCALAPPDATA as string,
			"Google",
			"Chrome",
			"User Data",
		);
		// Create in non-sorted order; discovery must still land on Profile 1.
		for (const profile of ["Profile 10", "Profile 2", "Profile 1"]) {
			mkdirSync(path.join(userData, profile), { recursive: true });
			writeFileSync(path.join(userData, profile, "History"), "");
		}

		expect(discoverChromeHistoryWindows()).toBe(
			path.join(userData, "Profile 1", "History"),
		);
	});

	test("Chrome history — picks Profile 2 over Profile 10 (numeric sort, not lexicographic)", () => {
		const userData = path.join(
			process.env.LOCALAPPDATA as string,
			"Google",
			"Chrome",
			"User Data",
		);
		// No Default, no Profile 1 — lexicographic sort would pick Profile 10.
		for (const profile of ["Profile 10", "Profile 2"]) {
			mkdirSync(path.join(userData, profile), { recursive: true });
			writeFileSync(path.join(userData, profile, "History"), "");
		}

		expect(discoverChromeHistoryWindows()).toBe(
			path.join(userData, "Profile 2", "History"),
		);
	});

	test("Chrome history — null when nothing exists", () => {
		expect(discoverChromeHistoryWindows()).toBeNull();
	});

	test("Firefox — picks the first profile with a places.sqlite", () => {
		const profiles = path.join(
			process.env.APPDATA as string,
			"Mozilla",
			"Firefox",
			"Profiles",
		);
		mkdirSync(path.join(profiles, "aaaaa.default-release"), {
			recursive: true,
		});
		writeFileSync(
			path.join(profiles, "aaaaa.default-release", "places.sqlite"),
			"",
		);

		const resolved = discoverFirefoxProfileWindows();
		expect(resolved).toBe(
			path.join(profiles, "aaaaa.default-release", "places.sqlite"),
		);
	});

	test("VSCode workspaceStorage resolves under APPDATA", () => {
		const root = path.join(
			process.env.APPDATA as string,
			"Code",
			"User",
			"workspaceStorage",
		);
		mkdirSync(root, { recursive: true });
		expect(discoverVSCodeWorkspaceStorageWindows()).toBe(root);
	});

	test("Cursor workspaceStorage resolves under APPDATA", () => {
		const root = path.join(
			process.env.APPDATA as string,
			"Cursor",
			"User",
			"workspaceStorage",
		);
		mkdirSync(root, { recursive: true });
		expect(discoverCursorWorkspaceStorageWindows()).toBe(root);
	});

	test("VSCode returns null when the directory is absent", () => {
		expect(discoverVSCodeWorkspaceStorageWindows()).toBeNull();
	});

	test("Obsidian — resolves iCloud Drive vault container", () => {
		const home = process.env.USERPROFILE as string;
		const vault = path.join(
			home,
			"iCloudDrive",
			"iCloud~md~obsidian",
			"PUNK RECORDS",
		);
		mkdirSync(path.join(vault, ".obsidian"), { recursive: true });

		expect(discoverObsidianVaultWindows()).toBe(vault);
	});

	test("Obsidian — OneDrive vault still resolves after iCloud root added", () => {
		const home = process.env.USERPROFILE as string;
		const vault = path.join(home, "OneDrive", "Documents", "MyVault");
		mkdirSync(path.join(vault, ".obsidian"), { recursive: true });

		expect(discoverObsidianVaultWindows()).toBe(vault);
	});

	test("Obsidian — null when no vault anywhere", () => {
		expect(discoverObsidianVaultWindows()).toBeNull();
	});

	test("Windows Timeline — resolves ActivitiesCache.db under a device-hash subdir", () => {
		const root = path.join(
			process.env.LOCALAPPDATA as string,
			"ConnectedDevicesPlatform",
		);
		const deviceDir = path.join(root, "da9ed9198cc45ad3");
		mkdirSync(deviceDir, { recursive: true });
		const dbFile = path.join(deviceDir, "ActivitiesCache.db");
		writeFileSync(dbFile, "");

		expect(discoverWindowsTimeline()).toBe(dbFile);
	});

	test("Windows Timeline — resolves the older L.<username> subdir form", () => {
		const root = path.join(
			process.env.LOCALAPPDATA as string,
			"ConnectedDevicesPlatform",
		);
		const legacyDir = path.join(root, "L.danit");
		mkdirSync(legacyDir, { recursive: true });
		const dbFile = path.join(legacyDir, "ActivitiesCache.db");
		writeFileSync(dbFile, "");

		expect(discoverWindowsTimeline()).toBe(dbFile);
	});

	test("Windows Timeline — null when ConnectedDevicesPlatform has no DB", () => {
		expect(discoverWindowsTimeline()).toBeNull();
	});

	test("PowerShell history — resolves PSReadLine parent directory (legacy 5.1)", () => {
		const root = path.join(
			process.env.APPDATA as string,
			"Microsoft",
			"Windows",
			"PowerShell",
			"PSReadLine",
		);
		mkdirSync(root, { recursive: true });
		writeFileSync(path.join(root, "ConsoleHost_history.txt"), "");

		expect(discoverPowerShellHistoryWindows()).toBe(root);
	});

	test("PowerShell history — prefers pwsh (PS7) over legacy when both exist", () => {
		const legacy = path.join(
			process.env.APPDATA as string,
			"Microsoft",
			"Windows",
			"PowerShell",
			"PSReadLine",
		);
		const pwsh = path.join(
			process.env.APPDATA as string,
			"Microsoft",
			"PowerShell",
			"PSReadLine",
		);
		mkdirSync(legacy, { recursive: true });
		mkdirSync(pwsh, { recursive: true });

		expect(discoverPowerShellHistoryWindows()).toBe(pwsh);
	});

	test("PowerShell history — resolves pwsh path when only PS7 is installed", () => {
		const pwsh = path.join(
			process.env.APPDATA as string,
			"Microsoft",
			"PowerShell",
			"PSReadLine",
		);
		mkdirSync(pwsh, { recursive: true });
		writeFileSync(path.join(pwsh, "ConsoleHost_history.txt"), "");

		expect(discoverPowerShellHistoryWindows()).toBe(pwsh);
	});

	test("PowerShell history — null when PSReadLine directory is absent", () => {
		expect(discoverPowerShellHistoryWindows()).toBeNull();
	});

	test("appData() fallback — resolves against runtime homedir when APPDATA is unset", () => {
		// Regression: localAppData()/appData() fall back to homedir() at call
		// time (not the module-level HOME const) so tests overriding only
		// USERPROFILE still resolve correctly. See Cursor review on PR #26.
		const savedAppData = process.env.APPDATA;
		delete process.env.APPDATA;
		try {
			const home = process.env.USERPROFILE as string;
			const pwsh = path.join(
				home,
				"AppData",
				"Roaming",
				"Microsoft",
				"PowerShell",
				"PSReadLine",
			);
			mkdirSync(pwsh, { recursive: true });
			expect(discoverPowerShellHistoryWindows()).toBe(pwsh);
		} finally {
			if (savedAppData !== undefined) process.env.APPDATA = savedAppData;
		}
	});

	test("Claude Code history — resolves against runtime USERPROFILE, not module-load HOME", () => {
		// Regression: discoverClaudeCodeHistory (used as both discover and
		// discoverWindows for claude_code_history) must read homedir() at call
		// time so tests can override USERPROFILE. See Cursor review on PR #26.
		const home = process.env.USERPROFILE as string;
		const projects = path.join(home, ".claude", "projects");
		mkdirSync(projects, { recursive: true });

		const spec = PERSONAL_SOURCES.find(
			(s) => s.connector === "claude_code_history",
		);
		expect(spec?.discoverWindows?.()).toBe(projects);
	});
});
