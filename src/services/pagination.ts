/**
 * Shared pagination helper for list endpoints that enforce `limit <= 100`.
 *
 * Several CLI flows historically called list endpoints with a single large
 * `limit` (e.g. `sources.list({ limit: 200 })` in `commands/project.ts`,
 * `available-sources?limit=500` in `commands/vault.ts`) to "just get
 * everything in one shot". The Nia backend now rejects `limit > 100` with:
 *
 *     Validation error: query → limit: Input should be less than or equal to 100
 *
 * which broke `nia project init` entirely. `paginateAll` is the correct
 * replacement: it walks pages of at most 100, accepts all response shapes
 * currently returned by Nia endpoints (bare array, `{ items }`, `{ sources }`),
 * stops as soon as a page comes back short, and refuses to loop past a
 * safety ceiling.
 *
 * Mirrors the smaller inlined loop in `commands/sources.ts:fetchAllSources`
 * which predates this helper — that function could be migrated to use this
 * helper in a later refactor, but is left alone here to keep the diff
 * focused on the regression fix.
 */

/** Response shapes we've seen from Nia list endpoints. */
type PageResult<T> =
	| T[]
	| { items?: T[] }
	| { sources?: T[] }
	| null
	| undefined;

export interface PaginateOptions {
	/**
	 * Per-request page size. Clamped to 100 because the backend rejects
	 * larger values. Default 100.
	 */
	pageSize?: number;
	/**
	 * Hard ceiling on total items collected. Prevents runaway loops against
	 * a buggy server that always returns a full page. Default 500, matching
	 * the widest single-call limit used in the codebase before this helper
	 * existed.
	 */
	max?: number;
}

/** Maximum `limit` value accepted by the Nia API. */
const API_MAX_PAGE_SIZE = 100;

/**
 * Walk a paginated list endpoint and return a flat array of items.
 *
 * The `fetchPage` callback is invoked with `{ limit, offset }` and must
 * return the raw server response (array or `{items}`/`{sources}` wrapper).
 * `paginateAll` stops when the server returns fewer items than requested
 * (end reached) or when `max` items have been collected.
 */
export async function paginateAll<T>(
	fetchPage: (opts: {
		limit: number;
		offset: number;
	}) => Promise<PageResult<T>>,
	options: PaginateOptions = {},
): Promise<T[]> {
	const pageSize = Math.min(
		Math.max(1, options.pageSize ?? API_MAX_PAGE_SIZE),
		API_MAX_PAGE_SIZE,
	);
	const max = Math.max(pageSize, options.max ?? 500);

	const aggregate: T[] = [];
	let offset = 0;

	// Safety: cap iteration count defensively in case the server ever returns
	// a full page of zero-length data. At pageSize=100 and max=500 this
	// bounds the loop at 5; we allow a generous multiple to future-proof.
	const maxIterations = Math.ceil(max / pageSize) + 1;

	for (let i = 0; i < maxIterations; i++) {
		const result = await fetchPage({ limit: pageSize, offset });
		const batch = extractItems<T>(result);
		aggregate.push(...batch);

		if (batch.length < pageSize) {
			break;
		}
		if (aggregate.length >= max) {
			break;
		}
		offset += pageSize;
	}

	return aggregate;
}

function extractItems<T>(result: PageResult<T>): T[] {
	if (Array.isArray(result)) {
		return result;
	}
	if (result && typeof result === "object") {
		if (Array.isArray((result as { items?: T[] }).items)) {
			return (result as { items: T[] }).items;
		}
		if (Array.isArray((result as { sources?: T[] }).sources)) {
			return (result as { sources: T[] }).sources;
		}
	}
	return [];
}
