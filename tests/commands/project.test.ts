/**
 * Regression tests for `commands/project.ts` source-picker pagination.
 *
 * The `nia project init` command used to call `cliSdk.sources.list({
 * limit: 200 })` in its `pickSources()` helper. The backend now rejects any
 * `limit > 100` with:
 *
 *     Validation error: query → limit: Input should be less than or equal to 100
 *
 * which broke `nia project init` at startup. These tests lock in the fix:
 * the command must never send `limit > 100`, must page through results,
 * and must aggregate items across pages.
 */

import { describe, expect, test } from "bun:test";
import { fetchAllSourcesForPicker } from "../../src/commands/project.ts";

type ListCall = { limit?: number; offset?: number };

function makeFakeSdk(pages: Array<{ items: Array<{ id: string }> }>): {
	sdk: {
		sources: {
			list: (params?: {
				limit?: number;
				offset?: number;
			}) => Promise<{ items: Array<{ id: string }> }>;
		};
	};
	calls: ListCall[];
} {
	const calls: ListCall[] = [];
	const sdk = {
		sources: {
			list: async (params?: { limit?: number; offset?: number }) => {
				calls.push({ limit: params?.limit, offset: params?.offset });
				const idx = (params?.offset ?? 0) / (params?.limit ?? 100);
				return pages[idx] ?? { items: [] };
			},
		},
	};
	return { sdk, calls };
}

describe("fetchAllSourcesForPicker", () => {
	test("never calls sources.list with limit > 100 (API cap regression)", async () => {
		const { sdk, calls } = makeFakeSdk([{ items: [{ id: "a" }] }]);

		await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);

		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) {
			expect(c.limit ?? 0).toBeLessThanOrEqual(100);
		}
	});

	test("aggregates sources across multiple pages", async () => {
		const page1 = {
			items: Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}` })),
		};
		const page2 = {
			items: Array.from({ length: 100 }, (_, i) => ({ id: `p2-${i}` })),
		};
		const page3 = {
			items: Array.from({ length: 7 }, (_, i) => ({ id: `p3-${i}` })),
		};
		const { sdk, calls } = makeFakeSdk([page1, page2, page3]);

		const items = await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);

		expect(items).toHaveLength(207);
		expect((items[0] as { id: string }).id).toBe("p1-0");
		expect((items[200] as { id: string }).id).toBe("p3-0");
		// Paginated, not one huge call.
		expect(calls).toHaveLength(3);
		expect(calls[0]?.offset).toBe(0);
		expect(calls[1]?.offset).toBe(100);
		expect(calls[2]?.offset).toBe(200);
	});

	test("returns [] when SDK reports no sources", async () => {
		const { sdk, calls } = makeFakeSdk([{ items: [] }]);
		const items = await fetchAllSourcesForPicker(
			sdk as unknown as Parameters<typeof fetchAllSourcesForPicker>[0],
		);
		expect(items).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.limit ?? 0).toBeLessThanOrEqual(100);
	});
});
