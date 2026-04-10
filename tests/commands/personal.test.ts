import { describe, expect, test } from "bun:test";
import { parseEnableList } from "../../src/commands/personal.ts";

describe("personal command helpers", () => {
	test("parseEnableList returns null for undefined", () => {
		expect(parseEnableList(undefined)).toBeNull();
	});

	test("parseEnableList returns null for 'all'", () => {
		expect(parseEnableList("all")).toBeNull();
	});

	test("parseEnableList trims, lowercases, and splits connectors", () => {
		expect(parseEnableList(" Notes, SAFARI ,imessage ")).toEqual([
			"notes",
			"safari",
			"imessage",
		]);
	});

	test("parseEnableList drops empty connector values", () => {
		expect(parseEnableList("notes,, ,safari, ")).toEqual([
			"notes",
			"safari",
		]);
	});
});
