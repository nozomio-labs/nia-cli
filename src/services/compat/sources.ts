export type ResolvedSource = {
	id?: string;
	type?: string;
	display_name?: string | null;
	displayName?: string | null;
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
			items: value.items
				.filter(
					(item): item is Record<string, unknown> =>
						typeof item === "object" && item !== null && !Array.isArray(item),
				)
				.map(normalizeResolvedSource),
		};
	}

	return {
		items: [normalizeResolvedSource(value)],
	};
}

function normalizeResolvedSource(
	value: Record<string, unknown>,
): ResolvedSource {
	return {
		id: typeof value.id === "string" ? value.id : undefined,
		type: typeof value.type === "string" ? value.type : undefined,
		display_name:
			typeof value.display_name === "string" || value.display_name === null
				? (value.display_name as string | null)
				: typeof value.displayName === "string" || value.displayName === null
					? (value.displayName as string | null)
					: undefined,
		displayName:
			typeof value.displayName === "string" || value.displayName === null
				? (value.displayName as string | null)
				: typeof value.display_name === "string" || value.display_name === null
					? (value.display_name as string | null)
					: undefined,
		identifier:
			typeof value.identifier === "string" || value.identifier === null
				? (value.identifier as string | null)
				: undefined,
		status: typeof value.status === "string" ? value.status : undefined,
	};
}
