/**
 * Shared test configuration for nia-cli tests.
 *
 * This file is loaded via bunfig.toml preload before test execution.
 * Add global mocks, test helpers, and shared fixtures here.
 */

import os from "node:os";
import path from "node:path";

// Ensure tests don't accidentally use real config paths
const testConfigHome = path.join(os.tmpdir(), "nia-cli-test-config");
process.env.XDG_CONFIG_HOME = testConfigHome;

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
	const _noop = () => {};
	// biome-ignore lint/suspicious/noExplicitAny: test setup intentionally silences console
	(globalThis as any).__originalConsole = {
		log: console.log,
		error: console.error,
		warn: console.warn,
	};
}
