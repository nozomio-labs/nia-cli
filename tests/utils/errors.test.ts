import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- Mock process.exit ---

const mockExit = mock((code?: number) => {
	throw new Error(`process.exit(${code})`);
});

const originalExit = process.exit;
const originalArgv = process.argv;

// --- Mock modules ---

// We need to import CrustError from @crustjs/core for type-checking
// but we also need access to the actual classes from nia-ai-ts

// Import the actual error classes
import { CrustError } from "@crustjs/core";
import { CancelledError } from "@crustjs/prompts";
import { ApiError, NiaSDKError, NiaTimeoutError } from "nia-ai-ts";
import { handleError, withErrorHandling } from "../../src/utils/errors.ts";

describe("error handling", () => {
	let consoleErrorOutput: string[];
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		consoleErrorOutput = [];
		// biome-ignore lint/suspicious/noExplicitAny: test mock override
		process.exit = mockExit as any;
		process.argv = ["bun", "nia", "search", "universal", "test"];

		// Capture console.error output
		originalConsoleError = console.error;
		console.error = ((...args: unknown[]) => {
			consoleErrorOutput.push(args.map(String).join(" "));
		}) as typeof console.error;
	});

	afterEach(() => {
		process.exit = originalExit;
		process.argv = originalArgv;
		console.error = originalConsoleError;
		mock.restore();
	});

	// --- ApiError handling ---

	describe("ApiError handling", () => {
		function createApiError(
			status: number,
			message: string,
			body?: unknown,
		): ApiError {
			// biome-ignore lint/suspicious/noExplicitAny: test mock for ApiError constructor params
			const request = { method: "GET", url: "/test" } as any;
			const response = {
				url: "/test",
				ok: false,
				status,
				statusText: message,
				body: body ?? {},
				// biome-ignore lint/suspicious/noExplicitAny: test mock for ApiError constructor params
			} as any;
			return new ApiError(request, response, message);
		}

		test("handles 401 authentication error", () => {
			const error = createApiError(401, "Unauthorized");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Authentication failed")),
			).toBe(true);
			expect(consoleErrorOutput.some((s) => s.includes("nia auth login"))).toBe(
				true,
			);
		});

		test("handles 403 forbidden error", () => {
			const error = createApiError(403, "Forbidden");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Authentication failed")),
			).toBe(true);
		});

		test("handles 404 not found error with domain", () => {
			const error = createApiError(404, "Not Found");
			try {
				handleError(error, { domain: "Repository" });
			} catch {}
			expect(
				consoleErrorOutput.some((s) =>
					s.includes("Repository resource not found"),
				),
			).toBe(true);
		});

		test("handles 404 not found error without domain", () => {
			const error = createApiError(404, "Not Found");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Resource not found")),
			).toBe(true);
		});

		test("handles 422 validation error with detail body", () => {
			const error = createApiError(422, "Unprocessable Entity", {
				detail: "Invalid URL format",
			});
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Validation error")),
			).toBe(true);
			expect(
				consoleErrorOutput.some((s) => s.includes("Invalid URL format")),
			).toBe(true);
		});

		test("handles 422 validation error with detail array", () => {
			const error = createApiError(422, "Unprocessable Entity", {
				detail: [
					{ msg: "field required", loc: ["body", "url"] },
					{ msg: "invalid type", loc: ["body", "name"] },
				],
			});
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Validation error")),
			).toBe(true);
			expect(consoleErrorOutput.some((s) => s.includes("body"))).toBe(true);
		});

		test("handles 429 rate limit error", () => {
			const error = createApiError(429, "Too Many Requests");
			try {
				handleError(error);
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Rate limited"))).toBe(
				true,
			);
		});

		test("handles 500 server error", () => {
			const error = createApiError(500, "Internal Server Error");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Server error (500)")),
			).toBe(true);
		});

		test("shows underlying server detail when available", () => {
			const error = createApiError(500, "Internal Server Error", {
				message: "Database unavailable",
			});
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) =>
					s.includes("Server error (500): Database unavailable"),
				),
			).toBe(true);
		});

		test("handles 502 server error", () => {
			const error = createApiError(502, "Bad Gateway");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Server error (502)")),
			).toBe(true);
		});

		test("handles unknown status code with domain", () => {
			const error = createApiError(418, "I'm a teapot");
			try {
				handleError(error, { domain: "Search" });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Search failed"))).toBe(
				true,
			);
			expect(consoleErrorOutput.some((s) => s.includes("418"))).toBe(true);
		});

		test("shows response body in verbose mode", () => {
			process.argv = ["bun", "nia", "--verbose", "search", "universal", "test"];
			const error = createApiError(500, "Internal Server Error", {
				detail: "Something went wrong",
			});
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Response body"))).toBe(
				true,
			);
			expect(
				consoleErrorOutput.some((s) => s.includes("Something went wrong")),
			).toBe(true);
		});

		test("shows stack trace in verbose mode", () => {
			const error = createApiError(500, "Internal Server Error");
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
				true,
			);
		});
	});

	// --- NiaTimeoutError handling ---

	describe("NiaTimeoutError handling", () => {
		test("handles timeout error with friendly message", () => {
			const error = new NiaTimeoutError("Request timed out after 30000ms");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Request timed out")),
			).toBe(true);
			expect(
				consoleErrorOutput.some((s) => s.includes("Try again later")),
			).toBe(true);
		});

		test("shows details in verbose mode", () => {
			const error = new NiaTimeoutError("Request timed out after 30000ms");
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Details"))).toBe(true);
			expect(consoleErrorOutput.some((s) => s.includes("30000ms"))).toBe(true);
		});
	});

	// --- NiaSDKError handling ---

	describe("NiaSDKError handling", () => {
		test("handles generic SDK error", () => {
			const error = new NiaSDKError("SDK connection failed");
			try {
				handleError(error);
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("SDK error"))).toBe(
				true,
			);
			expect(
				consoleErrorOutput.some((s) => s.includes("SDK connection failed")),
			).toBe(true);
		});

		test("shows stack trace in verbose mode", () => {
			const error = new NiaSDKError("SDK connection failed");
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
				true,
			);
		});
	});

	// --- CrustError handling ---

	describe("CrustError handling", () => {
		test("rethrows CrustError for Crust-native formatting", () => {
			const error = new CrustError("PARSE", 'Unknown flag "--foo"');
			expect(() => handleError(error)).toThrow(CrustError);
			expect(consoleErrorOutput.length).toBe(0);
		});

		test("withErrorHandling also rethrows CrustError", async () => {
			const error = new CrustError("VALIDATION", "Missing required argument");
			await expect(
				withErrorHandling({ domain: "Search" }, async () => {
					throw error;
				}),
			).rejects.toThrow(CrustError);
			expect(consoleErrorOutput.length).toBe(0);
		});
	});

	// --- Generic Error handling ---

	describe("generic Error handling", () => {
		test("handles plain Error with message", () => {
			const error = new Error("Something went wrong");
			try {
				handleError(error);
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Something went wrong")),
			).toBe(true);
		});

		test("handles plain Error with domain", () => {
			const error = new Error("Connection refused");
			try {
				handleError(error, { domain: "Oracle" });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Oracle failed"))).toBe(
				true,
			);
			expect(
				consoleErrorOutput.some((s) => s.includes("Connection refused")),
			).toBe(true);
		});

		test("handles Error with status property", () => {
			const error = Object.assign(new Error("Not Found"), { status: 404 });
			try {
				handleError(error, { domain: "Source" });
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("Source resource not found")),
			).toBe(true);
		});

		test("uses attached body details for status errors", () => {
			const error = Object.assign(new Error("Bad Request"), {
				status: 400,
				body: { detail: "Unsupported experimental flag" },
			});
			try {
				handleError(error, { domain: "Search" });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Bad request"))).toBe(
				true,
			);
			expect(
				consoleErrorOutput.some((s) =>
					s.includes("Unsupported experimental flag"),
				),
			).toBe(true);
		});

		test("handles non-Error thrown value (string)", () => {
			try {
				handleError("unexpected string error");
			} catch {}
			expect(
				consoleErrorOutput.some((s) => s.includes("unexpected string error")),
			).toBe(true);
		});

		test("handles non-Error thrown value (number)", () => {
			try {
				handleError(42);
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("42"))).toBe(true);
		});

		test("handles null/undefined", () => {
			try {
				handleError(null);
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("null"))).toBe(true);
		});

		test("shows stack trace in verbose mode for generic Error", () => {
			const error = new Error("test error");
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
				true,
			);
		});

		test("shows response body in verbose mode for status errors", () => {
			const error = Object.assign(new Error("Bad Request"), {
				status: 400,
				body: { detail: "Unsupported experimental flag" },
			});
			try {
				handleError(error, { verbose: true, domain: "Search" });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Response body"))).toBe(
				true,
			);
			expect(
				consoleErrorOutput.some((s) =>
					s.includes("Unsupported experimental flag"),
				),
			).toBe(true);
		});

		test("shows cause in verbose mode for generic Error", () => {
			const error = Object.assign(new Error("outer failure"), {
				cause: new Error("inner failure"),
			});
			try {
				handleError(error, { verbose: true });
			} catch {}
			expect(consoleErrorOutput.some((s) => s.includes("Cause"))).toBe(true);
			expect(consoleErrorOutput.some((s) => s.includes("inner failure"))).toBe(
				true,
			);
		});
	});

	// --- CancelledError handling ---
	//
	// CancelledError is thrown by `@crustjs/prompts` when the user hits
	// Ctrl+C during any interactive prompt. It is NOT an error condition:
	// we want `handleError` to exit silently with code 130 (POSIX SIGINT
	// convention) — no message, no stack trace, no "Error:" prefix.
	// The user pressed Ctrl+C, they know what they did.

	describe("CancelledError handling", () => {
		test("exits silently with code 130 (no output at all)", () => {
			try {
				handleError(new CancelledError("user pressed ctrl+c"));
			} catch (e) {
				expect((e as Error).message).toBe("process.exit(130)");
			}
			expect(consoleErrorOutput).toEqual([]);
		});

		test("emits nothing even with --verbose", () => {
			process.argv = ["bun", "nia", "project", "init", "--verbose"];
			try {
				handleError(new CancelledError("any"), { verbose: true });
			} catch {}

			expect(consoleErrorOutput).toEqual([]);
		});

		test("is handled by withErrorHandling too (exits silently with 130)", async () => {
			try {
				await withErrorHandling({ domain: "Project init" }, async () => {
					throw new CancelledError("user cancelled picker");
				});
			} catch (e) {
				expect((e as Error).message).toBe("process.exit(130)");
			}
			expect(consoleErrorOutput).toEqual([]);
		});
	});

	// --- process.exit behavior ---

	describe("process.exit behavior", () => {
		test("calls process.exit(1) for all error types", () => {
			const errors = [
				new Error("test"),
				new NiaSDKError("test"),
				new NiaTimeoutError("test"),
				"string error",
				42,
			];

			for (const error of errors) {
				try {
					handleError(error);
				} catch (e) {
					expect((e as Error).message).toBe("process.exit(1)");
				}
			}
		});
	});
});

// --- withErrorHandling ---

describe("withErrorHandling", () => {
	let consoleErrorOutput: string[];
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		consoleErrorOutput = [];
		// biome-ignore lint/suspicious/noExplicitAny: test mock override
		process.exit = mockExit as any;
		process.argv = ["bun", "nia", "search", "universal", "test"];

		originalConsoleError = console.error;
		console.error = ((...args: unknown[]) => {
			consoleErrorOutput.push(args.map(String).join(" "));
		}) as typeof console.error;
	});

	afterEach(() => {
		process.exit = originalExit;
		process.argv = originalArgv;
		console.error = originalConsoleError;
		mock.restore();
	});

	test("does not catch when fn succeeds", async () => {
		await withErrorHandling({ domain: "Test" }, async () => {
			// no-op
		});
		expect(consoleErrorOutput.length).toBe(0);
	});

	test("catches and handles errors from fn", async () => {
		try {
			await withErrorHandling({ domain: "Search" }, async () => {
				throw new Error("API call failed");
			});
		} catch {}
		expect(consoleErrorOutput.some((s) => s.includes("Search failed"))).toBe(
			true,
		);
		expect(consoleErrorOutput.some((s) => s.includes("API call failed"))).toBe(
			true,
		);
	});

	test("uses verbose when passed in options", async () => {
		try {
			await withErrorHandling({ domain: "Search", verbose: true }, async () => {
				throw new Error("API call failed");
			});
		} catch {}
		expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
			true,
		);
	});

	test("does not show stack trace without verbose", async () => {
		try {
			await withErrorHandling({ domain: "Search" }, async () => {
				throw new Error("API call failed");
			});
		} catch {}
		expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
			false,
		);
	});

	test("uses --verbose from argv when options omit verbose", async () => {
		process.argv = ["bun", "nia", "--verbose", "search", "universal", "test"];
		try {
			await withErrorHandling({ domain: "Search" }, async () => {
				throw new Error("API call failed");
			});
		} catch {}
		expect(consoleErrorOutput.some((s) => s.includes("Stack trace"))).toBe(
			true,
		);
	});

	test("handles ApiError through withErrorHandling", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock for ApiError constructor params
		const request = { method: "GET", url: "/test" } as any;
		const response = {
			url: "/test",
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			body: {},
			// biome-ignore lint/suspicious/noExplicitAny: test mock for ApiError constructor params
		} as any;
		const apiError = new ApiError(request, response, "Too Many Requests");

		try {
			await withErrorHandling({ domain: "Oracle" }, async () => {
				throw apiError;
			});
		} catch {}
		expect(consoleErrorOutput.some((s) => s.includes("Rate limited"))).toBe(
			true,
		);
	});
});
