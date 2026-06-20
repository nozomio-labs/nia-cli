import { describe, expect, test } from "bun:test";
import { readEventStream } from "../../src/utils/streaming.ts";

/**
 * Build a ReadableStream<Uint8Array> from a list of chunks. String chunks are
 * UTF-8 encoded; Uint8Array chunks are enqueued as-is so tests can split bytes
 * mid-character or mid-line.
 */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					typeof chunk === "string" ? encoder.encode(chunk) : chunk,
				);
			}
			controller.close();
		},
	});
}

async function collect(
	chunks: (string | Uint8Array)[],
): Promise<Record<string, unknown>[]> {
	const events: Record<string, unknown>[] = [];
	await readEventStream(streamOf(chunks), (event) => {
		events.push(event);
	});
	return events;
}

describe("readEventStream", () => {
	test("parses each data: line as an event", async () => {
		const events = await collect([
			'data: {"type":"a"}\n',
			'data: {"type":"b"}\n',
		]);
		expect(events).toEqual([{ type: "a" }, { type: "b" }]);
	});

	test("emits a final event that arrives without a trailing newline", async () => {
		// Regression: the previous inlined loops dropped the trailing buffer when
		// the stream closed, silently losing the last frame.
		const events = await collect([
			'data: {"type":"first"}\n',
			'data: {"type":"last"}',
		]);
		expect(events).toEqual([{ type: "first" }, { type: "last" }]);
	});

	test("does not emit twice when the stream ends with a trailing newline", async () => {
		const events = await collect(['data: {"type":"only"}\n']);
		expect(events).toEqual([{ type: "only" }]);
	});

	test("ignores blank lines and non-data lines", async () => {
		const events = await collect([
			": keep-alive comment\n",
			"\n",
			"event: message\n",
			'data: {"type":"real"}\n',
			"\n",
		]);
		expect(events).toEqual([{ type: "real" }]);
	});

	test("skips malformed JSON payloads and continues", async () => {
		const events = await collect(["data: not-json\n", 'data: {"type":"ok"}\n']);
		expect(events).toEqual([{ type: "ok" }]);
	});

	test("reassembles a data line split across chunks", async () => {
		const events = await collect(['data: {"ty', 'pe":"split"}\n']);
		expect(events).toEqual([{ type: "split" }]);
	});

	test("decodes a multi-byte character split across chunk boundaries", async () => {
		const full = new TextEncoder().encode('data: {"name":"café"}\n');
		// The "é" encodes to two bytes; split between them to force the decoder
		// to buffer the partial character across reads.
		const splitAt = full.indexOf(0xc3) + 1;
		const events = await collect([
			full.subarray(0, splitAt),
			full.subarray(splitAt),
		]);
		expect(events).toEqual([{ name: "café" }]);
	});

	test("no-ops on an empty stream", async () => {
		const events = await collect([]);
		expect(events).toEqual([]);
	});
});
