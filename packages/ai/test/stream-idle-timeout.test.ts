import { describe, expect, it } from "vitest";
import { StreamIdleTimeoutError, withStreamIdleTimeout } from "../src/utils/stream-idle-timeout.js";

/** Helper: create an async iterable that yields values with configurable delays */
async function* delayedStream(items: { value: string; delayMs: number }[]): AsyncGenerator<string> {
	for (const item of items) {
		await new Promise((r) => setTimeout(r, item.delayMs));
		yield item.value;
	}
}

/** Helper: create an async iterable that never yields (hangs forever) */
async function* hangingStream(): AsyncGenerator<string> {
	await new Promise(() => {}); // never resolves
	yield "unreachable";
}

describe("withStreamIdleTimeout", () => {
	it("passes through all items when no timeout occurs", async () => {
		const items = [
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
			{ value: "c", delayMs: 10 },
		];
		const result: string[] = [];
		for await (const item of withStreamIdleTimeout(delayedStream(items), 500)) {
			result.push(item);
		}
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("throws StreamIdleTimeoutError when stream hangs before first chunk", async () => {
		await expect(async () => {
			for await (const _item of withStreamIdleTimeout(hangingStream(), 100)) {
				// should not reach here
			}
		}).rejects.toThrow(StreamIdleTimeoutError);
	});

	it("throws StreamIdleTimeoutError when gap between chunks exceeds timeout", async () => {
		const items = [
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 300 }, // exceeds 100ms timeout
		];
		const result: string[] = [];
		await expect(async () => {
			for await (const item of withStreamIdleTimeout(delayedStream(items), 100)) {
				result.push(item);
			}
		}).rejects.toThrow(StreamIdleTimeoutError);
		expect(result).toEqual(["a"]); // only first item received before timeout
	});

	it("includes timeout duration in error message", async () => {
		try {
			for await (const _item of withStreamIdleTimeout(hangingStream(), 150)) {
				// should not reach here
			}
		} catch (error) {
			expect(error).toBeInstanceOf(StreamIdleTimeoutError);
			expect((error as StreamIdleTimeoutError).message).toContain("0.15s");
			expect((error as StreamIdleTimeoutError).timeoutMs).toBe(150);
		}
	});

	it("passes through when timeoutMs is 0 (disabled)", async () => {
		const items = [
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
		];
		const result: string[] = [];
		for await (const item of withStreamIdleTimeout(delayedStream(items), 0)) {
			result.push(item);
		}
		expect(result).toEqual(["a", "b"]);
	});

	it("passes through when timeoutMs is undefined", async () => {
		const items = [
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
		];
		const result: string[] = [];
		for await (const item of withStreamIdleTimeout(delayedStream(items), undefined)) {
			result.push(item);
		}
		expect(result).toEqual(["a", "b"]);
	});

	it("cleans up timer on normal completion", async () => {
		const items = [{ value: "done", delayMs: 10 }];
		const result: string[] = [];
		for await (const item of withStreamIdleTimeout(delayedStream(items), 5000)) {
			result.push(item);
		}
		expect(result).toEqual(["done"]);
	});
});
