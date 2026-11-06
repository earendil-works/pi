import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream producer backpressure", () => {
	it("caps buffered events for slow iterators and preserves order", async () => {
		const stream = new EventStream<number, number>((value) => value === 199, (value) => value);
		const iterator = stream[Symbol.asyncIterator]();
		const first = iterator.next();
		let produced = 0;
		const producer = (async () => {
			for (let index = 0; index < 200; index++) {
				await stream.pushWithBackpressure(index, 4);
				produced++;
			}
			stream.end(199);
		})();
		const values = [(await first).value];
		await Promise.resolve();
		await Promise.resolve();
		expect(produced).toBeLessThanOrEqual(5);
		while (values.length < 200) values.push((await iterator.next()).value);
		await producer;
		expect(values).toEqual(Array.from({ length: 200 }, (_, index) => index));
		expect(await stream.result()).toBe(199);
	});

	it("never deadlocks a consumer which awaits only result()", async () => {
		const stream = new EventStream<number, number>((value) => value === 199, (value) => value);
		for (let index = 0; index < 200; index++) await stream.pushWithBackpressure(index, 4);
		expect(await stream.result()).toBe(199);
	});

	it("releases queued producers when the stream ends", async () => {
		const stream = new EventStream<number, number>(() => false, (value) => value);
		const iterator = stream[Symbol.asyncIterator]();
		const first = iterator.next();
		stream.push(1);
		expect((await first).value).toBe(1);
		await stream.pushWithBackpressure(2, 1);
		const blocked = stream.pushWithBackpressure(3, 1);
		stream.end(99);
		await blocked;
		expect(await stream.result()).toBe(99);
		expect((await iterator.next()).value).toBe(2);
		expect((await iterator.next()).done).toBe(true);
	});

	it("releases producer after an iterator exits early", async () => {
		const stream = new EventStream<number, number>(() => false, (value) => value);
		const iterator = stream[Symbol.asyncIterator]();
		const first = iterator.next();
		stream.push(1);
		await first;
		await stream.pushWithBackpressure(2, 1);
		const blocked = stream.pushWithBackpressure(3, 1);
		await iterator.return?.();
		await blocked;
		stream.end(42);
		expect(await stream.result()).toBe(42);
	});
});
