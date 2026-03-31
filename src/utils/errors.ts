/**
 * Centralized error handling for the Nia CLI.
 *
 * Provides a unified `handleError()` function that maps SDK and API
 * errors to user-friendly messages, and a `withErrorHandling()` wrapper for
 * command handlers.
 */

import { CrustError } from "@crustjs/core";
import { ApiError, NiaSDKError, NiaTimeoutError } from "nia-ai-ts";

/**
 * Options for error handling behavior.
 */
export interface ErrorHandlerOptions {
	/** When true, print full stack traces and raw API response bodies. */
	verbose?: boolean;
	/** Domain context for generic error messages (e.g., "Search", "Oracle"). */
	domain?: string;
}

type StatusError = Error & {
	status?: number;
	body?: unknown;
	cause?: unknown;
};

/**
 * Format a user-friendly error message for the given error and print it.
 * Delegates `CrustError` formatting to Crust; otherwise exits with code 1.
 */
export function handleError(
	error: unknown,
	options: ErrorHandlerOptions = {},
): never {
	const { verbose = false, domain } = options;

	if (error instanceof CrustError) {
		throw error;
	}

	if (error instanceof ApiError) {
		return handleStatusCode(
			error.status,
			error.message,
			verbose,
			domain,
			error.body,
			error.stack,
		);
	}

	if (error instanceof NiaTimeoutError) {
		console.error(
			"Request timed out — the server took too long to respond. Try again later.",
		);
		if (verbose) console.error(`\nDetails: ${error.message}`);
		printStackIfVerbose(verbose, error.stack);
		exitWithError();
	}

	if (error instanceof NiaSDKError) {
		console.error(`SDK error: ${error.message}`);
		printStackIfVerbose(verbose, error.stack);
		exitWithError();
	}

	if (error instanceof Error) {
		const statusError = error as StatusError;
		if (typeof statusError.status === "number") {
			return handleStatusCode(
				statusError.status,
				statusError.message,
				verbose,
				domain,
				statusError.body,
				statusError.stack,
				statusError.cause,
			);
		}

		const label = domain ? `${domain} failed` : "Error";
		console.error(`${label}: ${error.message}`);
		printCauseIfVerbose(verbose, statusError.cause);
		printStackIfVerbose(verbose, error.stack);
		exitWithError();
	}

	const label = domain ? `${domain} failed` : "Error";
	console.error(`${label}: ${String(error)}`);
	exitWithError();
}

/**
 * Map HTTP status codes to user-friendly error messages.
 */
function handleStatusCode(
	status: number,
	message: string,
	verbose: boolean,
	domain?: string,
	body?: unknown,
	stack?: string,
	cause?: unknown,
): never {
	const detailMessage = extractDetailMessage(body) ?? message;
	let primaryMessage: string;

	switch (true) {
		case status === 401 || status === 403:
			primaryMessage =
				"Authentication failed — run `nia auth login` to authenticate.";
			break;

		case status === 404: {
			const label = domain ? `${domain} resource` : "Resource";
			primaryMessage = `${label} not found. Check the ID or identifier and try again.`;
			break;
		}

		case status === 400:
			primaryMessage = `Bad request: ${detailMessage}`;
			break;

		case status === 409:
			primaryMessage = `Conflict: ${detailMessage}`;
			break;

		case status === 422:
			primaryMessage = `Validation error: ${detailMessage}`;
			break;

		case status === 429:
			primaryMessage = "Rate limited — try again in a moment.";
			break;

		case status >= 500:
			primaryMessage = isMeaningfulDetail(status, detailMessage)
				? `Server error (${status}): ${detailMessage}`
				: `Server error (${status}) — try again later.`;
			break;

		default: {
			const label = domain ? `${domain} failed` : "Request failed";
			primaryMessage = `${label} (${status}): ${detailMessage}`;
		}
	}

	console.error(primaryMessage);
	printStatusDetailIfUseful(status, detailMessage, primaryMessage);

	if (verbose) {
		if (body !== undefined) {
			console.error(`\nResponse body:\n${formatBody(body)}`);
		}
		printCauseIfVerbose(verbose, cause);
		printStackIfVerbose(verbose, stack);
	}

	exitWithError();
}

function printStackIfVerbose(
	verbose: boolean,
	stack: string | undefined,
): void {
	if (verbose && stack) {
		console.error(`\nStack trace:\n${stack}`);
	}
}

function printCauseIfVerbose(verbose: boolean, cause: unknown): void {
	if (!verbose || cause === undefined) {
		return;
	}

	const renderedCause =
		cause instanceof Error
			? cause.stack ?? cause.message
			: formatBody(cause);
	console.error(`\nCause:\n${renderedCause}`);
}

function exitWithError(): never {
	process.exit(1);
}

/**
 * Extract a user-readable detail message from an API error body.
 * Many APIs return { detail: string | { msg: string }[] }.
 */
function extractDetailMessage(body: unknown): string | undefined {
	if (body == null) return undefined;

	if (typeof body === "object") {
		const obj = body as Record<string, unknown>;

		// { detail: "message" }
		if (typeof obj.detail === "string") {
			return obj.detail;
		}

		// { detail: [{ msg: "message", loc: [...] }] }
		if (Array.isArray(obj.detail)) {
			return obj.detail
				.map((d: Record<string, unknown>) => {
					const loc = Array.isArray(d.loc) ? d.loc.join(" → ") : "";
					const msg = typeof d.msg === "string" ? d.msg : String(d.msg);
					return loc ? `${loc}: ${msg}` : msg;
				})
				.join("; ");
		}

		// { message: "message" }
		if (typeof obj.message === "string") {
			return obj.message;
		}

		// { error: "message" }
		if (typeof obj.error === "string") {
			return obj.error;
		}
	}

	if (typeof body === "string") {
		return body;
	}

	return undefined;
}

function isMeaningfulDetail(status: number, detail: string | undefined): boolean {
	if (!detail) {
		return false;
	}

	return detail !== `Request failed with status ${status}`;
}

function printStatusDetailIfUseful(
	status: number,
	detail: string | undefined,
	primaryMessage: string,
): void {
	if (
		!detail ||
		primaryMessage.includes(detail) ||
		!isMeaningfulDetail(status, detail)
	) {
		return;
	}

	console.error(`Details: ${detail}`);
}

/**
 * Format a response body for verbose output.
 */
function formatBody(body: unknown): string {
	if (typeof body === "string") return body;
	try {
		return JSON.stringify(body, null, 2);
	} catch {
		return String(body);
	}
}

export async function createResponseError(
	response: Response,
	fallbackMessage: string,
): Promise<StatusError> {
	const body = await readResponseBody(response);
	const detailMessage = extractDetailMessage(body);
	const error = new Error(
		detailMessage ?? `${fallbackMessage} (status ${response.status})`,
	) as StatusError;
	error.status = response.status;
	error.body = body;
	return error;
}

async function readResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) {
		return undefined;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Wrap a command handler with centralized error handling.
 *
 * Usage in a defineCommand run() handler:
 *
 * ```ts
 * async run({ args, flags }) {
 *   await withErrorHandling({ domain: "Search" }, async () => {
 *     // ... command logic ...
 *   });
 * }
 * ```
 *
 * Callers should pass `verbose` via the options if needed.
 */
export async function withErrorHandling(
	options: ErrorHandlerOptions,
	fn: () => Promise<void>,
): Promise<void> {
	const resolvedOptions = {
		...options,
		verbose: options.verbose ?? process.argv.includes("--verbose"),
	};

	try {
		await fn();
	} catch (error) {
		handleError(error, resolvedOptions);
	}
}
