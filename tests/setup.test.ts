import { describe, expect, test } from "bun:test";

describe("test setup", () => {
	test("test runner is configured correctly", () => {
		expect(true).toBe(true);
	});

	test("XDG_CONFIG_HOME is set to test directory", () => {
		expect(process.env.XDG_CONFIG_HOME).toBeDefined();
		expect(process.env.XDG_CONFIG_HOME).toContain("nia-cli-test-config");
	});
});
