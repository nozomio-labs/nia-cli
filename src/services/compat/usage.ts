export type CliUsage = {
	plan?: string;
	period?: string;
	usage: Record<
		string,
		{
			used: number;
			limit?: number;
			unlimited: boolean;
			remaining?: number | "unlimited";
			isLifetime?: boolean;
		}
	>;
};

type UsageBucket = CliUsage["usage"][string];

export function normalizeUsageSummary(input: unknown): CliUsage {
	const source = isRecord(input) ? input : {};

	return {
		plan: getString(source.tier) ?? getString(source.subscription_tier),
		period: formatPeriod(source),
		usage: normalizeUsageBuckets(source),
	};
}

export function formatCliUsageLines(normalized: CliUsage): string[] {
	const lines: string[] = [];

	if (normalized.plan) {
		lines.push(`Plan: ${normalized.plan}`);
	}

	if (normalized.period) {
		lines.push(`Period: ${normalized.period}`);
	}

	const entries = Object.entries(normalized.usage);
	if (entries.length === 0) {
		lines.push(
			lines.length > 0
				? "\nNo usage data available."
				: "No usage data available.",
		);
		return lines;
	}

	lines.push("\nBalance:");
	for (const [key, entry] of entries) {
		if (entry.unlimited) {
			lines.push(`  ${key}: ∞`);
			continue;
		}

		const remaining = effectiveRemaining(entry);
		if (remaining !== undefined && typeof entry.limit === "number") {
			lines.push(`  ${key}: ${remaining}/${entry.limit}`);
			continue;
		}

		lines.push(`  ${key}: ${entry.used}`);
	}

	return lines;
}

function effectiveRemaining(entry: UsageBucket): number | undefined {
	if (entry.unlimited || typeof entry.limit !== "number") {
		return undefined;
	}
	if (typeof entry.remaining === "number") {
		return entry.remaining;
	}
	return Math.max(0, entry.limit - entry.used);
}

export function printCliUsage(normalized: CliUsage): void {
	for (const line of formatCliUsageLines(normalized)) {
		console.log(line);
	}
}

function normalizeUsageBuckets(
	source: Record<string, unknown>,
): CliUsage["usage"] {
	const usage = source.usage;
	if (isBucketRecord(usage)) {
		return Object.fromEntries(
			Object.entries(usage).map(([key, value]) => [
				key,
				normalizeBucket(value),
			]),
		);
	}

	const buckets = source.buckets;
	if (isBucketRecord(buckets)) {
		return Object.fromEntries(
			Object.entries(buckets).map(([key, value]) => [
				key,
				normalizeBucket(value),
			]),
		);
	}

	if (Array.isArray(buckets)) {
		return Object.fromEntries(
			buckets
				.map((bucket) => {
					if (!isRecord(bucket)) {
						return undefined;
					}

					const key =
						getString(bucket.name) ??
						getString(bucket.key) ??
						getString(bucket.bucket) ??
						getString(bucket.operation) ??
						getString(bucket.type);

					if (!key) {
						return undefined;
					}

					return [key, normalizeBucket(bucket)] as const;
				})
				.filter(
					(entry): entry is readonly [string, UsageBucket] =>
						entry !== undefined,
				),
		);
	}

	return {};
}

function normalizeBucket(input: unknown): UsageBucket {
	const bucket = isRecord(input) ? input : {};
	const limitValue = bucket.limit;
	const remainingValue = bucket.remaining;

	return {
		used: typeof bucket.used === "number" ? bucket.used : 0,
		limit: typeof limitValue === "number" ? limitValue : undefined,
		unlimited: bucket.unlimited === true || limitValue === "unlimited",
		remaining:
			typeof remainingValue === "number" || remainingValue === "unlimited"
				? remainingValue
				: undefined,
		isLifetime:
			typeof bucket.isLifetime === "boolean" ? bucket.isLifetime : undefined,
	};
}

function formatPeriod(source: Record<string, unknown>): string | undefined {
	const directPeriod = getString(source.period);
	if (directPeriod) {
		return directPeriod;
	}

	if (isRecord(source.period)) {
		const start = getString(source.period.start);
		const end = getString(source.period.end);
		if (start && end) {
			return `${start} — ${end}`;
		}
	}

	const start = getString(source.billing_period_start);
	const end = getString(source.billing_period_end);
	if (start && end) {
		return `${start} — ${end}`;
	}

	return undefined;
}

/** Top-level shape check only; `normalizeBucket` validates each inner value. */
function isBucketRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
