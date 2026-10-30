import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { createHost } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { expectCollected, flushed } from "../support.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("memory links", () => {
	it("deliver in order, one task later, and queue what arrives before the listener", async () => {
		const [a, b] = memoryLinkPair();
		const got: number[] = [];
		a.send(bytes(1));
		a.send(bytes(2));
		await flushed();
		b.onMessage((message) => got.push(message[0]!));
		expect(got).toEqual([1, 2]);
		a.send(bytes(3));
		expect(got).toEqual([1, 2]);
		await flushed();
		expect(got).toEqual([1, 2, 3]);
	});

	it("close this end at once and the peer one task later; send after close is a no-op", async () => {
		const [a, b] = memoryLinkPair();
		const closes: string[] = [];
		const got: number[] = [];
		a.onClose(() => closes.push("a"));
		b.onClose(() => closes.push("b"));
		b.onMessage((message) => got.push(message[0]!));
		a.close();
		expect(closes).toEqual(["a"]);
		a.send(bytes(1));
		await flushed();
		expect(closes).toEqual(["a", "b"]);
		b.send(bytes(2));
		await flushed();
		expect(got).toEqual([]);
		const late: string[] = [];
		a.onClose(() => late.push("late"));
		expect(late).toEqual(["late"]);
	});

	it("drop messages still in flight to a closed end", async () => {
		const [a, b] = memoryLinkPair();
		const got: number[] = [];
		a.onMessage((message) => got.push(message[0]!));
		b.send(bytes(1));
		a.close();
		await flushed();
		expect(got).toEqual([]);
	});

	it("stop delivering queued messages once a listener closed the link", async () => {
		const [a, b] = memoryLinkPair();
		const got: number[] = [];
		a.send(bytes(1));
		a.send(bytes(2));
		await flushed();
		b.onMessage((message) => {
			got.push(message[0]!);
			b.close();
		});
		expect(got).toEqual([1]);
	});

	it("keep no listener once closed", async () => {
		const [a, b] = memoryLinkPair();
		const refs = (() => {
			const listener = { onMessage: () => {} };
			a.onMessage(listener.onMessage);
			a.onClose(listener.onMessage);
			return [new WeakRef(listener.onMessage)];
		})();
		a.close();
		await flushed();
		await expectCollected(...refs);
		expect(b).toBeDefined();
	});
});

describe("a closed memory link", () => {
	it("keeps no listener set after its close: accepting it keeps no host", async () => {
		const [a, b] = memoryLinkPair();
		a.close();
		await flushed();
		const refs = await (async () => {
			const host = createHost({ onError: () => {} });
			await host.load([], BACKGROUND_CONTEXT);
			host.accept(a, { principal: { kind: "owner" } }, BACKGROUND_CONTEXT);
			return [new WeakRef(host)];
		})();
		await expectCollected(...refs);
		expect([a, b]).toBeDefined();
	});
});
