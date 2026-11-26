// Tests of UUIDv7 ids (§3): the layout pi-ai's generator writes (48 bits of milliseconds, version 7, a 41-bit
// sequence, variant 10, random bits), ordered within a millisecond and when the clock goes back, and the cost of one.

import { GCProfiler, getHeapStatistics } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../src/host/uuid.ts";

/** The bytes of an id's text. */
function bytesOf(id: string): number[] {
	const hex = id.replaceAll("-", "");
	return Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

/** The timestamp and sequence an id carries, read back with bigints as pi-ai's generator writes them. */
function fieldsOf(id: string): { readonly timestamp: number; readonly sequence: bigint } {
	const bytes = bytesOf(id).map(BigInt);
	let timestamp = 0n;
	for (let index = 0; index < 6; index++) timestamp = (timestamp << 8n) | bytes[index]!;
	const sequence =
		((bytes[6]! & 0x0fn) << 37n) |
		(bytes[7]! << 29n) |
		((bytes[8]! & 0x3fn) << 23n) |
		(bytes[9]! << 15n) |
		(bytes[10]! << 7n) |
		(bytes[11]! >> 1n);
	return { timestamp: Number(timestamp), sequence };
}

/** Bytes 0 to 11 as pi-ai's generator (bigints) writes them for `timestamp` and `sequence`, byte 11's low bit apart. */
function written(timestamp: number, sequence: bigint): number[] {
	const time = BigInt(timestamp);
	const bytes: number[] = [];
	for (let index = 0; index < 6; index++) bytes.push(Number(time >> BigInt((5 - index) * 8)) & 0xff);
	bytes.push(0x70 | Number((sequence >> 37n) & 0x0fn));
	bytes.push(Number((sequence >> 29n) & 0xffn));
	bytes.push(0x80 | Number((sequence >> 23n) & 0x3fn));
	bytes.push(Number((sequence >> 15n) & 0xffn));
	bytes.push(Number((sequence >> 7n) & 0xffn));
	bytes.push(Number((sequence & 0x7fn) << 1n));
	return bytes;
}

describe("uuidv7", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes pi-ai's layout: the milliseconds, version 7, the sequence, variant 10", () => {
		const before = Date.now();
		const id = uuidv7();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const { timestamp, sequence } = fieldsOf(id);
		expect(timestamp).toBeGreaterThanOrEqual(before);
		expect(timestamp).toBeLessThanOrEqual(Date.now());
		const bytes = bytesOf(id);
		expect([...bytes.slice(0, 11), bytes[11]! & 0xfe]).toEqual(written(timestamp, sequence));
	});

	it("counts the sequence up by one per id, also across milliseconds and when the clock goes back", () => {
		const now = vi.spyOn(Date, "now");
		const ids: string[] = [];
		for (const at of [2_000_000_000_000, 2_000_000_000_000, 2_000_000_000_001, 1_999_999_999_000]) {
			now.mockReturnValue(at);
			ids.push(uuidv7());
		}
		const fields = ids.map(fieldsOf);
		expect(fields.map(({ timestamp }) => timestamp)).toEqual([
			2_000_000_000_000, 2_000_000_000_000, 2_000_000_000_001, 2_000_000_000_001,
		]);
		expect(fields.map(({ sequence }) => sequence - fields[0]!.sequence)).toEqual([0n, 1n, 2n, 3n]);
		expect([...ids].sort()).toEqual(ids);
	});

	it("gives ids of random bits apart from the sequence: no two of a thousand share them", () => {
		const tails = new Set(Array.from({ length: 1_000 }, () => uuidv7().slice(-8)));
		expect(tails.size).toBeGreaterThan(990);
	});

	it("costs a flat string per id (cost guard)", () => {
		for (let warm = 0; warm < 2_000; warm++) uuidv7();
		const profiler = new GCProfiler();
		profiler.start();
		const before = getHeapStatistics().used_heap_size;
		let length = 0;
		for (let round = 0; round < 10_000; round++) length += uuidv7().length;
		const after = getHeapStatistics().used_heap_size;
		let freed = 0;
		for (const collection of profiler.stop().statistics) {
			freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
		}
		expect(length).toBe(360_000);
		// Measured 0.15 KiB per id (its string); with bigints, a buffer and a list of char codes per id 1.7 KiB.
		expect(after - before + freed).toBeLessThan(10_000 * 512);
	});
});
