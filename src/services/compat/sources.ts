export type ResolvedSource = {
	id?: string;
	type?: string;
	display_name?: string | null;
	identifier?: string | null;
	status?: string;
};

export type NormalizedResolvedSources = {
	query?: string;
	items: ResolvedSource[];
};

export function normalizeResolvedSourcesResponse(
	input: unknown,
): NormalizedResolvedSources {
	if (!input || typeof input !== "object") {
		return { items: [] };
	}

	const value = input as Record<string, unknown>;
	if (Array.isArray(value.items)) {
		return {
			query: typeof value.query === "string" ? value.query : undefined,
			items: value.items.filter(
				(item): item is ResolvedSource =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			),
		};
	}

	return {
		items: [value as ResolvedSource],
	};
}
