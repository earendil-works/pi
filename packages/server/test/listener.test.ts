import { describe, expect, test } from "vitest";
import type { ByteConnectionAcceptor } from "../src/connection.ts";
import type { ServerListener } from "../src/listener.ts";
import { createTestServer } from "../src/testing/index.ts";

class TestListener implements ServerListener {
	accept?: ByteConnectionAcceptor;
	startCount = 0;
	closeCount = 0;
	readonly startError: Error | undefined;

	constructor(startError?: Error) {
		this.startError = startError;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		this.startCount += 1;
		this.accept = accept;
		if (this.startError) throw this.startError;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

describe("Server listener composition", () => {
	test("starts and closes every configured listener", async () => {
		const first = new TestListener();
		const second = new TestListener();
		const { server } = createTestServer({ listeners: [first, second] });

		await server.start();
		expect(first.accept).toBeTypeOf("function");
		expect(second.accept).toBeTypeOf("function");

		await server.close();
		expect(first.closeCount).toBe(1);
		expect(second.closeCount).toBe(1);
	});

	test("closes previously started listeners when startup fails", async () => {
		const first = new TestListener();
		const failure = new Error("listener failed");
		const second = new TestListener(failure);
		const { server } = createTestServer({ listeners: [first, second] });

		await expect(server.start()).rejects.toBe(failure);
		expect(first.closeCount).toBe(1);
		expect(second.closeCount).toBe(0);
	});
});
