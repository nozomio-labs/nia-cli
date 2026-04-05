import type { StyleInstance } from "@crustjs/style";
import { createStyle } from "@crustjs/style";

/**
 * Options for the stream renderer.
 */
export interface StreamRendererOptions {
	/** Whether color output is enabled. */
	color?: boolean;
	/** Whether detailed progress output is enabled. */
	verbose?: boolean;
}

export interface SandboxStreamRenderResult {
	renderedText: boolean;
	renderedActivity: boolean;
}

// biome-ignore lint/complexity/useRegexLiterals: Using a string avoids Biome's control-character regex lint.
const ANSI_ESCAPE_PATTERN = new RegExp(
	String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
	"g",
);

export type SandboxSearchStreamEvent =
	| { type: "job"; jobId: string }
	| {
			type: "status";
			jobStatus: string;
			runtimeStatus?: string;
			daytonaSandboxId?: string;
			sandboxState?: string;
	  }
	| {
			type: "opencode";
			stream?: "stdout" | "stderr";
			line?: string;
			event?: unknown;
	  }
	| { type: "result"; jobId: string; payload: Record<string, unknown> }
	| { type: "error"; message: string; name?: string; code?: string }
	| { type: "done" };

/**
 * Render a single SSE event to the terminal.
 *
 * Events are printed incrementally — each call outputs one event.
 * When stdout is not a TTY, events are printed as JSON lines for
 * parseable output (per SPEC constraint: no ANSI codes when piped).
 *
 * @param event - The event object from an SSE stream.
 * @param options - Rendering options.
 */
export function renderStreamEvent(
	event: Record<string, unknown>,
	options: StreamRendererOptions = {},
): void {
	const isTTY = process.stdout.isTTY;

	// Non-TTY: output each event as a JSON line
	if (!isTTY) {
		console.log(JSON.stringify(event));
		return;
	}

	const style = createStyle({
		mode: options.color === false ? "never" : "auto",
	});

	const eventType = String(event.type ?? event.event ?? "data");
	const content = extractContent(event);

	if (content) {
		renderTTYEvent(style, eventType, content);
	}
}

/**
 * Stream events from an async iterable and render them progressively.
 *
 * @param stream - An async iterable of event objects (e.g., from sdk.oracle.streamJob()).
 * @param options - Rendering options.
 */
export async function renderStream(
	stream: AsyncIterable<Record<string, unknown>>,
	options: StreamRendererOptions = {},
): Promise<void> {
	for await (const event of stream) {
		renderStreamEvent(event, options);
	}
}

export function renderSandboxSearchStreamEvent(
	event: SandboxSearchStreamEvent,
	options: StreamRendererOptions = {},
): SandboxStreamRenderResult {
	if (!process.stdout.isTTY) {
		console.log(JSON.stringify(event));
		return { renderedText: false, renderedActivity: false };
	}

	const style = createStyle({
		mode: options.color === false ? "never" : "auto",
	});
	const verbose = Boolean(options.verbose);

	switch (event.type) {
		case "job":
			if (!verbose) {
				return { renderedText: false, renderedActivity: false };
			}
			console.log(style.dim(`Sandbox job: ${event.jobId}`));
			return { renderedText: false, renderedActivity: true };

		case "status":
			if (!verbose) {
				return { renderedText: false, renderedActivity: false };
			}
			console.log(style.dim(formatSandboxStatus(event)));
			return { renderedText: false, renderedActivity: true };

		case "opencode": {
			const renderedStructuredEvent = renderStructuredOpencodeEvent(
				style,
				event.event,
			);
			if (renderedStructuredEvent) {
				return renderedStructuredEvent;
			}

			const renderedLine = sanitizeOpencodeLine(event.line);
			if (renderedLine === null) {
				return { renderedText: false, renderedActivity: false };
			}

			if (event.stream === "stderr") {
				console.error(style.yellow(`[stderr] ${renderedLine}`));
				return { renderedText: false, renderedActivity: true };
			}

			if (!verbose) {
				return { renderedText: false, renderedActivity: false };
			}

			console.log(renderedLine);
			return { renderedText: false, renderedActivity: true };
		}

		case "result":
			return { renderedText: false, renderedActivity: false };

		case "error":
		case "done":
			return { renderedText: false, renderedActivity: false };
	}
}

function renderStructuredOpencodeEvent(
	style: StyleInstance,
	value: unknown,
): SandboxStreamRenderResult | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const eventType = typeof record.type === "string" ? record.type : null;

	if (eventType === "tool_use") {
		const toolSummary = formatOpencodeToolUse(record);
		if (!toolSummary) {
			return { renderedText: false, renderedActivity: false };
		}
		console.log(style.dim(toolSummary));
		return { renderedText: false, renderedActivity: true };
	}

	if (eventType === "step_start") {
		return { renderedText: false, renderedActivity: false };
	}

	if (eventType === "step_finish") {
		return { renderedText: false, renderedActivity: false };
	}

	if (eventType === "error") {
		const message = extractOpencodeErrorMessage(record);
		console.error(style.red(message ?? "OpenCode error."));
		return { renderedText: false, renderedActivity: true };
	}

	const extractedText = extractOpencodeDisplayText(record);
	if (!extractedText) {
		return null;
	}

	process.stdout.write(
		extractedText.endsWith("\n") ? extractedText : `${extractedText}\n`,
	);
	return { renderedText: true, renderedActivity: true };
}

/**
 * Extract the main content from an SSE event object.
 *
 * SSE events from the Nia API may have content in various fields
 * depending on the event type.
 */
function extractContent(event: Record<string, unknown>): string | null {
	// Check common content fields in order of specificity
	for (const field of ["content", "data", "message", "text", "result"]) {
		const value = event[field];
		if (value !== undefined && value !== null) {
			if (typeof value === "string") {
				return value;
			}
			return JSON.stringify(value, null, 2);
		}
	}

	// If no known content field, stringify the whole event (excluding type/event)
	const { type: _type, event: _event, ...rest } = event;
	if (Object.keys(rest).length > 0) {
		return JSON.stringify(rest, null, 2);
	}

	return null;
}

/**
 * Render a single event to the TTY with formatting.
 */
function renderTTYEvent(
	style: StyleInstance,
	eventType: string,
	content: string,
): void {
	const typeLabel = formatEventType(style, eventType);

	// For streaming text content (like oracle research output),
	// write directly without newline to allow progressive text assembly
	if (
		eventType === "content" ||
		eventType === "text" ||
		eventType === "delta"
	) {
		process.stdout.write(content);
		return;
	}

	// For status/metadata events, print with type label
	if (eventType === "done" || eventType === "complete" || eventType === "end") {
		console.log(`\n${typeLabel} ${style.green(content)}`);
		return;
	}

	if (eventType === "error") {
		console.log(`${typeLabel} ${style.red(content)}`);
		return;
	}

	// Default: print type label + content
	console.log(`${typeLabel} ${content}`);
}

/**
 * Format an event type label with color.
 */
function formatEventType(style: StyleInstance, eventType: string): string {
	switch (eventType) {
		case "thinking":
		case "searching":
		case "reading":
		case "analyzing":
			return style.dim(`[${eventType}]`);
		case "error":
			return style.red(`[${eventType}]`);
		case "done":
		case "complete":
		case "end":
			return style.green(`[${eventType}]`);
		default:
			return style.cyan(`[${eventType}]`);
	}
}

function formatSandboxStatus(
	event: Extract<SandboxSearchStreamEvent, { type: "status" }>,
): string {
	const segments = [`Status: ${event.jobStatus}`];

	if (event.runtimeStatus) {
		segments.push(`runtime=${event.runtimeStatus}`);
	}
	if (event.daytonaSandboxId) {
		segments.push(`sandbox=${event.daytonaSandboxId}`);
	}
	if (event.sandboxState) {
		segments.push(`state=${event.sandboxState}`);
	}

	return segments.join(" | ");
}

function extractOpencodeDisplayText(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	if (typeof record.text === "string" && record.text.trim().length > 0) {
		return record.text;
	}
	if (typeof record.content === "string" && record.content.trim().length > 0) {
		return record.content;
	}
	if (record.part && typeof record.part === "object") {
		const part = record.part as Record<string, unknown>;
		if (typeof part.text === "string" && part.text.trim().length > 0) {
			return part.text;
		}
		if (typeof part.content === "string" && part.content.trim().length > 0) {
			return part.content;
		}
	}
	if (Array.isArray(record.parts)) {
		const textParts = record.parts
			.filter(
				(part): part is Record<string, unknown> =>
					typeof part === "object" && part !== null,
			)
			.map((part) => {
				if (typeof part.text === "string" && part.text.trim().length > 0) {
					return part.text;
				}
				if (
					typeof part.content === "string" &&
					part.content.trim().length > 0
				) {
					return part.content;
				}
				return null;
			})
			.filter((part): part is string => part !== null);
		if (textParts.length > 0) {
			return textParts.join("");
		}
	}

	return null;
}

function formatOpencodeToolUse(value: Record<string, unknown>): string | null {
	const part =
		typeof value.part === "object" && value.part !== null
			? (value.part as Record<string, unknown>)
			: null;
	const state =
		typeof part?.state === "object" && part.state !== null
			? (part.state as Record<string, unknown>)
			: null;
	const metadata =
		typeof state?.metadata === "object" && state.metadata !== null
			? (state.metadata as Record<string, unknown>)
			: null;
	const toolName =
		typeof part?.tool === "string" && part.tool.trim().length > 0
			? part.tool.trim()
			: "tool";
	const title = firstNonEmptyString(
		typeof state?.title === "string" ? state.title : null,
		typeof metadata?.description === "string" ? metadata.description : null,
		extractToolInputSummary(
			typeof state?.input === "object" && state.input !== null
				? (state.input as Record<string, unknown>)
				: null,
		),
	);

	const exitCode =
		typeof metadata?.exit === "number" ? metadata.exit : undefined;
	const suffix =
		typeof exitCode === "number" ? ` (exit ${String(exitCode)})` : "";

	return title
		? `Tool ${toolName}: ${title}${suffix}`
		: `Tool ${toolName}${suffix}`;
}

function extractToolInputSummary(
	input: Record<string, unknown> | null,
): string | null {
	if (!input) {
		return null;
	}

	return firstNonEmptyString(
		typeof input.description === "string" ? input.description : null,
		typeof input.filePath === "string" ? input.filePath : null,
		typeof input.path === "string" ? input.path : null,
		typeof input.pattern === "string" ? input.pattern : null,
		typeof input.query === "string" ? input.query : null,
		typeof input.url === "string" ? input.url : null,
		typeof input.command === "string"
			? truncateOpencodeSnippet(input.command)
			: null,
	);
}

function firstNonEmptyString(
	...values: Array<string | null | undefined>
): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function truncateOpencodeSnippet(value: string, maxLength = 80): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function extractOpencodeErrorMessage(
	value: Record<string, unknown>,
): string | null {
	const error =
		typeof value.error === "object" && value.error !== null
			? (value.error as Record<string, unknown>)
			: null;
	const data =
		typeof error?.data === "object" && error.data !== null
			? (error.data as Record<string, unknown>)
			: null;

	return firstNonEmptyString(
		typeof data?.message === "string" ? data.message : null,
		typeof error?.message === "string" ? error.message : null,
		typeof error?.name === "string" ? error.name : null,
	);
}

function sanitizeOpencodeLine(line: string | undefined): string | null {
	if (typeof line !== "string") {
		return null;
	}

	const strippedLine = stripAnsi(line).replace(/\r/g, "").trim();
	if (strippedLine.length === 0) {
		return null;
	}
	if (looksLikeOpencodeProtocolJson(strippedLine)) {
		return null;
	}
	if (looksLikeShellBootstrap(strippedLine)) {
		return null;
	}
	if (strippedLine === "__NIA_PTY_EXIT__:0") {
		return null;
	}

	return strippedLine;
}

function looksLikeShellBootstrap(line: string): boolean {
	return (
		line.startsWith("stty -echo; printf '%s'") ||
		line.includes("opencode run --model") ||
		line.includes("base64 -d >") ||
		line.startsWith("%")
	);
}

function looksLikeOpencodeProtocolJson(line: string): boolean {
	if (!line.startsWith("{")) {
		return false;
	}

	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		const type = parsed.type;
		return (
			type === "step_start" ||
			type === "step_finish" ||
			type === "tool_use" ||
			type === "text"
		);
	} catch {
		return false;
	}
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_PATTERN, "");
}
