import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	resolveAddTarget,
	SUPPORTED_UPLOAD_CONTENT_TYPES,
} from "../../src/commands/add.ts";
import { resolveUploadContentType } from "../../src/commands/sources.ts";

describe("add command helpers", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("detects an existing folder target", () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-add-folder-"));

		const target = resolveAddTarget(tempDir);
		expect(target).toEqual({
			kind: "folder",
			path: tempDir,
		});
	});

	test("detects an existing file target with extension", () => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "nia-add-file-"));
		const filePath = path.join(tempDir, "notes.md");
		writeFileSync(filePath, "# hello");

		const target = resolveAddTarget(filePath);
		expect(target).toEqual({
			kind: "file",
			path: filePath,
			extension: ".md",
		});
	});

	test("detects http(s) URLs", () => {
		expect(resolveAddTarget("https://docs.example.com")).toEqual({
			kind: "url",
			url: "https://docs.example.com",
		});
	});

	test("returns unknown for missing paths and non-url strings", () => {
		const target = resolveAddTarget("/definitely/not/a/real/path");
		expect(target).toEqual({
			kind: "unknown",
			input: "/definitely/not/a/real/path",
		});
	});

	test("mentions supported upload file types for unsupported md/docx", () => {
		expect(() => resolveUploadContentType("/tmp/file.md")).toThrow(
			"Single-file .md uploads are not supported yet.",
		);
		expect(() => resolveUploadContentType("/tmp/file.docx")).toThrow(
			"Single-file .docx uploads are not supported yet.",
		);
		expect(() => resolveUploadContentType("/tmp/file.md")).toThrow(
			".pdf, .csv, .xlsx",
		);
		expect(() => resolveUploadContentType("/tmp/file.docx")).toThrow(
			".pdf, .csv, .xlsx",
		);
	});

	test("supported upload type map includes expected extensions", () => {
		expect(Object.keys(SUPPORTED_UPLOAD_CONTENT_TYPES)).toEqual([
			".pdf",
			".csv",
			".xlsx",
		]);
	});
});
