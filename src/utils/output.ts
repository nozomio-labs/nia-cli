import type { StyleInstance } from "@crustjs/style";
import { createStyle, table as styleTable } from "@crustjs/style";

/**
 * Supported output formats. Single source of truth for the type, the
 * resolver, and flag validation.
 */
export const OUTPUT_FORMATS = ["json", "table", "text"] as const;

/**
 * Output format modes.
 */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Options for creating an output helper.
 */
export interface OutputOptions {
	/** Explicit output format: "json", "table", or "text". Defaults to "text". */
	output?: string;
	/** Shorthand that forces JSON output, taking precedence over `output`. */
	json?: boolean;
	/** Whether color output is enabled. */
	color?: boolean;
}

/**
 * Resolve the output format from an explicit value.
 *
 * Returns the matching format when `output` is "json", "table", or "text"
 * (case-insensitive); falls back to "text" for anything else, including an
 * unset value.
 */
export function resolveOutputFormat(output?: string): OutputFormat {
	if (output) {
		const normalized = output.toLowerCase();
		if ((OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
			return normalized as OutputFormat;
		}
	}

	return "text";
}

/**
 * Validate an explicit `--output` value, exiting with an error when it is not
 * one of the supported formats. An unset value is allowed and defaults to
 * text. Mirrors the validation other commands apply to enum-like flags (e.g.
 * `--registry`, `--type`).
 */
export function validateOutputFormat(output?: string): void {
	if (
		output &&
		!(OUTPUT_FORMATS as readonly string[]).includes(output.toLowerCase())
	) {
		console.error(
			`Invalid output format: "${output}". Allowed: ${OUTPUT_FORMATS.join(", ")}`,
		);
		process.exit(1);
	}
}

/**
 * Maximum column width for table cells before truncation.
 */
const MAX_CELL_WIDTH = 60;

/**
 * Truncate a string to a maximum visible length, appending "..." if truncated.
 */
export function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	if (maxLength <= 3) {
		return value.slice(0, maxLength);
	}
	return `${value.slice(0, maxLength - 3)}...`;
}

/**
 * Shared CLI output renderer.
 */
export class OutputRenderer {
	readonly format: OutputFormat;
	readonly style: StyleInstance;

	constructor(options: OutputOptions = {}) {
		this.format = resolveOutputFormat(options.json ? "json" : options.output);
		this.style = createStyle({
			mode: options.color === false ? "never" : "auto",
		});
	}

	/**
	 * Format data as JSON with 2-space indentation.
	 */
	formatJson(data: unknown): string {
		return JSON.stringify(data, null, 2);
	}

	/**
	 * Format rows as an aligned table with headers.
	 *
	 * @param rows - Array of records to display.
	 * @param columns - Optional column names to include. If not provided,
	 *   uses the keys from the first row.
	 */
	formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
		if (rows.length === 0) {
			return this.style.dim("(no results)");
		}

		const cols = columns ?? Object.keys(rows[0] ?? {});
		if (cols.length === 0) {
			return this.style.dim("(no columns)");
		}

		const headers = cols.map((col) => {
			const label = col.replace(/([A-Z])/g, " $1").trim();
			return this.style.bold(label.charAt(0).toUpperCase() + label.slice(1));
		});

		const dataRows = rows.map((row) =>
			cols.map((col) => truncate(formatValue(row[col]), MAX_CELL_WIDTH)),
		);

		return styleTable(headers, dataRows, {
			cellPadding: 1,
		});
	}

	/**
	 * Format data as human-friendly text output.
	 */
	formatText(data: unknown, indent = 0): string {
		const prefix = "  ".repeat(indent);

		if (data === null || data === undefined) {
			return `${prefix}${this.style.dim("(none)")}`;
		}

		if (
			typeof data === "string" ||
			typeof data === "number" ||
			typeof data === "boolean"
		) {
			return `${prefix}${String(data)}`;
		}

		if (Array.isArray(data)) {
			if (data.length === 0) {
				return `${prefix}${this.style.dim("(empty)")}`;
			}

			if (data.every((item) => typeof item !== "object" || item === null)) {
				return data.map((item) => `${prefix}- ${String(item)}`).join("\n");
			}

			return data
				.map(
					(item, i) => `${prefix}[${i}]\n${this.formatText(item, indent + 1)}`,
				)
				.join("\n");
		}

		if (typeof data === "object") {
			const entries = Object.entries(data as Record<string, unknown>);
			if (entries.length === 0) {
				return `${prefix}${this.style.dim("(empty)")}`;
			}

			return entries
				.map(([key, value]) => {
					const label = this.style.bold(key);
					if (typeof value === "object" && value !== null) {
						return `${prefix}${label}:\n${this.formatText(value, indent + 1)}`;
					}
					return `${prefix}${label}: ${formatValue(value)}`;
				})
				.join("\n");
		}

		return `${prefix}${String(data)}`;
	}

	/**
	 * Format a list of items in a compact display.
	 */
	formatList(items: { id: string; name: string; status?: string }[]): string {
		if (items.length === 0) {
			return this.style.dim("(no items)");
		}

		return items
			.map((item) => {
				const id = this.style.dim(truncate(item.id, 12));
				const name = this.style.bold(item.name);
				const status = item.status ? ` ${this.formatStatus(item.status)}` : "";
				return `${id}  ${name}${status}`;
			})
			.join("\n");
	}

	/**
	 * Output data in the configured format.
	 */
	output(data: unknown, options?: { columns?: string[] }): void {
		let result: string;

		switch (this.format) {
			case "json":
				result = this.formatJson(data);
				break;
			case "table": {
				const rows = Array.isArray(data)
					? (data as Record<string, unknown>[])
					: [data as Record<string, unknown>];
				result = this.formatTable(rows, options?.columns);
				break;
			}
			case "text":
				result = this.formatText(data);
				break;
		}

		console.log(result);
	}

	// Diagnostics go to stderr so that the data payload from `output()` is the
	// only thing on stdout. This keeps `nia <cmd> --json | jq` clean even when a
	// command prints a status line (e.g. "nia.json detected …") before its
	// result. Mirrors the Unix convention shared by `warn`/`error`.
	success(message: string): void {
		console.error(this.style.green(message));
	}

	warn(message: string): void {
		console.error(this.style.yellow(message));
	}

	error(message: string): void {
		console.error(this.style.red(message));
	}

	info(message: string): void {
		console.error(this.style.dim(message));
	}

	private formatStatus(status: string): string {
		const lower = status.toLowerCase();
		switch (lower) {
			case "completed":
			case "ready":
			case "active":
			case "indexed":
				return this.style.green(status);
			case "running":
			case "queued":
			case "indexing":
			case "processing":
				return this.style.yellow(status);
			case "failed":
			case "error":
				return this.style.red(status);
			case "cancelled":
			case "canceled":
				return this.style.dim(status);
			default:
				return status;
		}
	}
}

/**
 * Convert an unknown value to a display string.
 */
function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(String).join(", ");
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}

/**
 * Factory function to create a shared output renderer.
 *
 * Validates the requested `--output` format up front, exiting with an error
 * for unsupported values so a mistyped format is surfaced rather than silently
 * falling back to text. When `--json` is set it overrides `--output`, so the
 * ignored `--output` value is skipped to keep that precedence consistent.
 */
export function createOutput(options: OutputOptions = {}): OutputRenderer {
	validateOutputFormat(options.json ? undefined : options.output);
	return new OutputRenderer(options);
}
