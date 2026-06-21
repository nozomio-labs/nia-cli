import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	createOutput,
	OutputRenderer,
	resolveOutputFormat,
	truncate,
	validateOutputFormat,
} from "../../src/utils/output.ts";

describe("resolveOutputFormat", () => {
	test("returns 'json' when explicit output is 'json'", () => {
		expect(resolveOutputFormat("json")).toBe("json");
	});

	test("returns 'table' when explicit output is 'table'", () => {
		expect(resolveOutputFormat("table")).toBe("table");
	});

	test("returns 'text' when explicit output is 'text'", () => {
		expect(resolveOutputFormat("text")).toBe("text");
	});

	test("is case-insensitive for explicit format", () => {
		expect(resolveOutputFormat("JSON")).toBe("json");
		expect(resolveOutputFormat("Table")).toBe("table");
		expect(resolveOutputFormat("TEXT")).toBe("text");
	});

	test("defaults to 'text' when no format specified", () => {
		expect(resolveOutputFormat()).toBe("text");
	});

	test("falls through to text for invalid format", () => {
		expect(resolveOutputFormat("invalid")).toBe("text");
	});
});

describe("validateOutputFormat", () => {
	const mockExit = mock((code?: number) => {
		throw new Error(`process.exit(${code})`);
	});
	const originalExit = process.exit;
	let consoleErrorOutput: string[];
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		consoleErrorOutput = [];
		// biome-ignore lint/suspicious/noExplicitAny: test mock override
		process.exit = mockExit as any;
		originalConsoleError = console.error;
		console.error = ((...args: unknown[]) => {
			consoleErrorOutput.push(args.map(String).join(" "));
		}) as typeof console.error;
	});

	afterEach(() => {
		process.exit = originalExit;
		console.error = originalConsoleError;
		mock.restore();
	});

	test("accepts supported formats", () => {
		expect(() => validateOutputFormat("json")).not.toThrow();
		expect(() => validateOutputFormat("table")).not.toThrow();
		expect(() => validateOutputFormat("text")).not.toThrow();
		expect(() => validateOutputFormat("JSON")).not.toThrow();
	});

	test("accepts an unset value", () => {
		expect(() => validateOutputFormat(undefined)).not.toThrow();
	});

	test("exits with an error for an unsupported format", () => {
		expect(() => validateOutputFormat("jsonl")).toThrow("process.exit(1)");
		expect(consoleErrorOutput.join("\n")).toContain(
			'Invalid output format: "jsonl"',
		);
		expect(consoleErrorOutput.join("\n")).toContain("json, table, text");
	});

	test("createOutput rejects an unsupported format", () => {
		expect(() => createOutput({ output: "xml" })).toThrow("process.exit(1)");
	});
});

describe("truncate", () => {
	test("returns original string when shorter than max", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	test("returns original string when equal to max", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	test("truncates with ellipsis when longer than max", () => {
		expect(truncate("hello world", 8)).toBe("hello...");
	});

	test("handles very short maxLength", () => {
		expect(truncate("hello", 2)).toBe("he");
	});

	test("handles maxLength of 3", () => {
		expect(truncate("hello", 3)).toBe("hel");
	});
});

describe("OutputRenderer", () => {
	const formatter = new OutputRenderer({ output: "text", color: false });

	describe("formatJson", () => {
		test("formats primitives as JSON", () => {
			expect(formatter.formatJson("hello")).toBe('"hello"');
			expect(formatter.formatJson(42)).toBe("42");
			expect(formatter.formatJson(true)).toBe("true");
			expect(formatter.formatJson(null)).toBe("null");
		});

		test("formats objects with 2-space indentation", () => {
			const result = formatter.formatJson({ name: "test", count: 3 });
			expect(result).toBe('{\n  "name": "test",\n  "count": 3\n}');
		});

		test("formats arrays with 2-space indentation", () => {
			const result = formatter.formatJson([1, 2, 3]);
			expect(result).toBe("[\n  1,\n  2,\n  3\n]");
		});

		test("formats nested structures", () => {
			const data = { items: [{ id: "1", name: "a" }] };
			const result = formatter.formatJson(data);
			const parsed = JSON.parse(result);
			expect(parsed.items[0].id).toBe("1");
		});
	});

	describe("formatTable", () => {
		test("returns empty message for empty rows", () => {
			const result = formatter.formatTable([]);
			expect(result).toBe("(no results)");
		});

		test("returns empty message for rows with no columns", () => {
			const result = formatter.formatTable([{}]);
			expect(result).toBe("(no columns)");
		});

		test("renders a table with auto-detected columns", () => {
			const rows = [
				{ name: "Alice", age: "30" },
				{ name: "Bob", age: "25" },
			];
			const result = formatter.formatTable(rows);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("Name");
			expect(plain).toContain("Age");
			expect(plain).toContain("Alice");
			expect(plain).toContain("Bob");
			expect(plain).toContain("30");
			expect(plain).toContain("25");
		});

		test("uses explicit columns when provided", () => {
			const rows = [{ name: "Alice", age: "30", email: "alice@test.com" }];
			const result = formatter.formatTable(rows, ["name", "email"]);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("Name");
			expect(plain).toContain("Email");
			expect(plain).toContain("Alice");
			expect(plain).toContain("alice@test.com");
			expect(plain).not.toContain("Age");
		});

		test("truncates long cell values", () => {
			const longValue = "a".repeat(100);
			const rows = [{ value: longValue }];
			const result = formatter.formatTable(rows);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("...");
			expect(plain).not.toContain("a".repeat(61));
		});

		test("capitalizes column headers", () => {
			const rows = [{ firstName: "Alice" }];
			const result = formatter.formatTable(rows);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("First Name");
		});
	});

	describe("formatText", () => {
		test("formats null as (none)", () => {
			expect(formatter.formatText(null)).toBe("(none)");
		});

		test("formats undefined as (none)", () => {
			expect(formatter.formatText(undefined)).toBe("(none)");
		});

		test("formats strings directly", () => {
			expect(formatter.formatText("hello")).toBe("hello");
		});

		test("formats numbers directly", () => {
			expect(formatter.formatText(42)).toBe("42");
		});

		test("formats booleans directly", () => {
			expect(formatter.formatText(true)).toBe("true");
		});

		test("formats empty array as (empty)", () => {
			expect(formatter.formatText([])).toBe("(empty)");
		});

		test("formats array of primitives as bulleted list", () => {
			expect(formatter.formatText(["a", "b", "c"])).toBe("- a\n- b\n- c");
		});

		test("formats empty object as (empty)", () => {
			expect(formatter.formatText({})).toBe("(empty)");
		});

		test("formats flat object with key-value pairs", () => {
			const result = formatter.formatText({ name: "test", count: 3 });
			const plain = Bun.stripANSI(result);
			expect(plain).toContain("name: test");
			expect(plain).toContain("count: 3");
		});

		test("formats nested objects with indentation", () => {
			const result = formatter.formatText({ outer: { inner: "value" } });
			const plain = Bun.stripANSI(result);
			expect(plain).toContain("outer:");
			expect(plain).toContain("inner: value");
		});

		test("respects indent parameter", () => {
			expect(formatter.formatText("hello", 2)).toBe("    hello");
		});
	});

	describe("formatList", () => {
		test("returns empty message for empty items", () => {
			expect(formatter.formatList([])).toBe("(no items)");
		});

		test("formats items with id, name, and optional status", () => {
			const items = [
				{ id: "abc123", name: "My Source", status: "ready" },
				{ id: "def456", name: "Another", status: "failed" },
				{ id: "ghi789", name: "No Status" },
			];
			const result = formatter.formatList(items);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("abc123");
			expect(plain).toContain("My Source");
			expect(plain).toContain("ready");
			expect(plain).toContain("def456");
			expect(plain).toContain("Another");
			expect(plain).toContain("failed");
			expect(plain).toContain("ghi789");
			expect(plain).toContain("No Status");
		});

		test("truncates long IDs", () => {
			const items = [{ id: "very-long-identifier-value-here", name: "Test" }];
			const result = formatter.formatList(items);
			const plain = Bun.stripANSI(result);

			expect(plain).toContain("very-long...");
		});
	});
});

describe("createOutput", () => {
	test("returns an OutputRenderer instance", () => {
		const fmt = createOutput();
		expect(fmt).toBeInstanceOf(OutputRenderer);
	});

	test("respects explicit output format", () => {
		const fmt = createOutput({ output: "json" });
		expect(fmt.format).toBe("json");
	});

	test("forces json when the json shorthand is set", () => {
		const fmt = createOutput({ json: true });
		expect(fmt.format).toBe("json");
	});

	test("json shorthand takes precedence over output", () => {
		const fmt = createOutput({ json: true, output: "table" });
		expect(fmt.format).toBe("json");
	});

	test("ignores the json shorthand when false", () => {
		const fmt = createOutput({ json: false, output: "table" });
		expect(fmt.format).toBe("table");
	});

	test("respects color option", () => {
		const fmt = createOutput({ color: false });
		expect(fmt.style.enabled).toBe(false);
	});
});

describe("OutputRenderer output method", () => {
	let logOutput: string[];
	const originalLog = console.log;

	beforeEach(() => {
		logOutput = [];
		console.log = (...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
	});

	test("outputs JSON when format is json", () => {
		const fmt = new OutputRenderer({ output: "json", color: false });
		fmt.output({ name: "test" });
		expect(logOutput.length).toBe(1);
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.name).toBe("test");
	});

	test("outputs text when format is text", () => {
		const fmt = new OutputRenderer({ output: "text", color: false });
		fmt.output({ name: "test" });
		expect(logOutput.length).toBe(1);
		expect(logOutput[0]).toContain("name");
		expect(logOutput[0]).toContain("test");
	});

	test("outputs table when format is table", () => {
		const fmt = new OutputRenderer({ output: "table", color: false });
		fmt.output([{ name: "Alice", age: "30" }]);
		expect(logOutput.length).toBe(1);
		const plain = Bun.stripANSI(logOutput[0] as string);
		expect(plain).toContain("Alice");
	});

	test("wraps single object in array for table format", () => {
		const fmt = new OutputRenderer({ output: "table", color: false });
		fmt.output({ name: "single" });
		expect(logOutput.length).toBe(1);
		const plain = Bun.stripANSI(logOutput[0] as string);
		expect(plain).toContain("single");
	});
});

describe("OutputRenderer convenience methods", () => {
	let logOutput: string[];
	let errOutput: string[];
	const originalLog = console.log;
	const originalError = console.error;

	beforeEach(() => {
		logOutput = [];
		errOutput = [];
		console.log = (...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			errOutput.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
	});

	test("success writes to stdout", () => {
		const fmt = new OutputRenderer({ color: false });
		fmt.success("done");
		expect(logOutput[0]).toBe("done");
	});

	test("warn writes to stderr", () => {
		const fmt = new OutputRenderer({ color: false });
		fmt.warn("warning");
		expect(errOutput[0]).toBe("warning");
	});

	test("error writes to stderr", () => {
		const fmt = new OutputRenderer({ color: false });
		fmt.error("failure");
		expect(errOutput[0]).toBe("failure");
	});

	test("info writes to stdout", () => {
		const fmt = new OutputRenderer({ color: false });
		fmt.info("note");
		expect(logOutput[0]).toBe("note");
	});
});
