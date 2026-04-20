/**
 * Tests for `services/pagination.ts` — the shared `paginateAll` helper that
 * walks paginated list endpoints safely under the API's `limit <= 100` cap.
 *
 * Regression: `nia project init` used to call `sources.list({ limit: 200 })`
 * which now trips the backend's `query → limit: Input should be less than or
 * equal to 100` validator. `paginateAll` is the shared loop that replaces
 * those ad-hoc single-page calls.
 *
 * What we verify:
 *   - Never calls the fetcher with `limit > 100`
 *   - Aggregates across multiple pages
 *   - Normalizes `T[]`, `{ items: T[] }`, and `{ sources: T[] }` shapes
 *   - Stops on short page (no extra request once end is reached)
 *   - Respects `max` ceiling (no runaway loop)
 *   - Handles empty first page cleanly
 */

import { describe, expect, test } from "bun:test";
import { paginateAll } from "../../src/services/pagination.ts";

describe("paginateAll", () => {
	test("never requests more than limit=100 per call (API cap)", async () => {
		const seen: Array<{ limit: number; offset: number }> = [];
		await paginateAll(async ({ limit, offset }) => {
			seen.push({ limit, offset });
			return [];
		});

		expect(seen.length).toBeGreaterThan(0);
		for (const call of seen) {
			expect(call.limit).toBeLessThanOrEqual(100);
		}
	});

	test("aggregates items across multiple pages ({items} shape)", async () => {
		const pages: Array<{ items: Array<{ id: string }> }> = [
			{ items: Array.from({ length: 100 }, (_, i) => ({ id: `a-${i}` })) },
			{ items: Array.from({ length: 100 }, (_, i) => ({ id: `b-${i}` })) },
			{ items: Array.from({ length: 23 }, (_, i) => ({ id: `c-${i}` })) },
		];

		const calls: Array<{ limit: number; offset: number }> = [];
		const items = await paginateAll<{ id: string }>(async (opts) => {
			calls.push(opts);
			const pageIndex = opts.offset / opts.limit;
			return pages[pageIndex] ?? { items: [] };
		});

		expect(items.length).toBe(223);
		expect(items[0]?.id).toBe("a-0");
		expect(items[100]?.id).toBe("b-0");
		expect(items[222]?.id).toBe("c-22");
		expect(calls).toEqual([
			{ limit: 100, offset: 0 },
			{ limit: 100, offset: 100 },
			{ limit: 100, offset: 200 },
		]);
	});

	test("normalizes bare-array response shape", async () => {
		const items = await paginateAll<{ n: number }>(async ({ offset }) => {
			if (offset === 0)
				return Array.from({ length: 100 }, (_, i) => ({ n: i }));
			if (offset === 100) return [{ n: 100 }, { n: 101 }];
			return [];
		});

		expect(items).toHaveLength(102);
		expect(items[101]).toEqual({ n: 101 });
	});

	test("normalizes {sources} response shape (vault endpoint)", async () => {
		const items = await paginateAll<{ id: string }>(async ({ offset }) => {
			if (offset === 0) {
				return {
					sources: Array.from({ length: 100 }, (_, i) => ({
						id: `s-${i}`,
					})),
				};
			}
			return { sources: [{ id: "tail" }] };
		});

		expect(items).toHaveLength(101);
		expect(items[100]).toEqual({ id: "tail" });
	});

	test("stops immediately when a page is shorter than pageSize", async () => {
		let callCount = 0;
		const items = await paginateAll<{ id: number }>(async () => {
			callCount++;
			return { items: [{ id: 1 }, { id: 2 }] };
		});

		expect(callCount).toBe(1);
		expect(items).toHaveLength(2);
	});

	test("respects max cap (no runaway)", async () => {
		let callCount = 0;
		const items = await paginateAll<{ id: number }>(
			async () => {
				callCount++;
				// Always returns a full page — would loop forever without a cap.
				return {
					items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
				};
			},
			{ max: 250 },
		);

		// Cap is total items, so 3 pages of 100 then stop (>= 250 reached).
		expect(items.length).toBeGreaterThanOrEqual(250);
		expect(callCount).toBeLessThanOrEqual(3);
	});

	test("handles empty first page", async () => {
		let callCount = 0;
		const items = await paginateAll<{ id: number }>(async () => {
			callCount++;
			return { items: [] };
		});

		expect(callCount).toBe(1);
		expect(items).toEqual([]);
	});

	test("honors custom pageSize but clamps to 100", async () => {
		const calls: number[] = [];
		await paginateAll(
			async ({ limit }) => {
				calls.push(limit);
				return [];
			},
			{ pageSize: 500 },
		);

		for (const limit of calls) {
			expect(limit).toBeLessThanOrEqual(100);
		}
	});
});
