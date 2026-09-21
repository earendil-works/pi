import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/ollama-chat.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"ollama-chat"> = {
	id: "local",
	name: "local",
	provider: "ollama",
	api: "ollama-chat",
	baseUrl: "http://localhost:11434",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const encoder = new TextEncoder();

function controlledBody() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({
		start(output) {
			controller = output;
		},
		cancel,
	});
	return { body, cancel, send: (text: string) => controller.enqueue(encoder.encode(text)) };
}

describe("Ollama idle timeout", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("keeps a real HTTP stream alive beyond its idle limit", async () => {
		vi.useRealTimers();
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/x-ndjson" });
			response.flushHeaders();
			let chunks = 0;
			const timer = setInterval(() => {
				response.write('{"message":{"content":"x"}}\n');
				if (++chunks === 75) response.end('{"done":true}\n');
			}, 20);
			response.on("close", () => clearInterval(timer));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing test server address");
			const started = Date.now();
			const result = await stream({ ...model, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
				timeoutMs: 1000,
			}).result();
			expect(result).toMatchObject({ stopReason: "stop", content: [{ text: "x".repeat(75) }] });
			expect(Date.now() - started).toBeGreaterThan(1000);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("allows an active generation to exceed the timeout many times", async () => {
		const body = controlledBody();
		const response = stream(model, context, { timeoutMs: 120, fetch: async () => new Response(body.body) });
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 50; i++) {
			await vi.advanceTimersByTimeAsync(20);
			body.send('{"message":{"content":"x"}}\n');
			await vi.advanceTimersByTimeAsync(0);
		}
		body.send('{"done":true,"done_reason":"stop"}\n');
		expect(await response.result()).toMatchObject({ stopReason: "stop", content: [{ text: "x".repeat(50) }] });
		expect(body.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resets on body bytes before a complete NDJSON record arrives", async () => {
		const body = controlledBody();
		const response = stream(model, context, { timeoutMs: 100, fetch: async () => new Response(body.body) });
		await vi.advanceTimersByTimeAsync(0);
		for (const fragment of ['{"message":', '{"content":', '"Hello"}}', '\n{"done":true}\n']) {
			await vi.advanceTimersByTimeAsync(80);
			body.send(fragment);
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(await response.result()).toMatchObject({ stopReason: "stop", content: [{ text: "Hello" }] });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts a request that stalls before response headers", async () => {
		let signal: AbortSignal | undefined;
		const response = stream(model, context, {
			timeoutMs: 100,
			fetch: async (_url, init) => {
				signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
				});
			},
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(await response.result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("idle timeout"),
		});
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])("aborts and cancels a stalled body, with prior content: %s", async (sendContent) => {
		const body = controlledBody();
		let signal: AbortSignal | undefined;
		const response = stream(model, context, {
			timeoutMs: 100,
			fetch: async (_url, init) => {
				signal = init?.signal ?? undefined;
				return new Response(body.body);
			},
		});
		await vi.advanceTimersByTimeAsync(80);
		if (sendContent) body.send('{"message":{"content":"partial"}}\n');
		await vi.advanceTimersByTimeAsync(sendContent ? 99 : 19);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await response.result()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("idle timeout"),
		});
		expect(body.cancel).toHaveBeenCalledOnce();
		expect(body.body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not treat empty chunks as activity", async () => {
		const body = controlledBody();
		const response = stream(model, context, { timeoutMs: 100, fetch: async () => new Response(body.body) });
		await vi.advanceTimersByTimeAsync(80);
		body.send("");
		await vi.advanceTimersByTimeAsync(20);
		expect((await response.result()).stopReason).toBe("error");
		expect(body.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves caller cancellation and clears the idle timer", async () => {
		const body = controlledBody();
		const controller = new AbortController();
		const response = stream(model, context, {
			timeoutMs: 100,
			signal: controller.signal,
			fetch: async () => new Response(body.body),
		});
		await vi.advanceTimersByTimeAsync(20);
		controller.abort();
		expect((await response.result()).stopReason).toBe("aborted");
		expect(body.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["fetch", "http", "record", "hook"])("clears the idle timer after a %s failure", async (failure) => {
		const response = stream(model, context, {
			timeoutMs: 100,
			fetch: async () => {
				if (failure === "fetch") throw new Error("connection refused");
				return new Response(failure === "http" ? "unavailable" : "invalid-json\n", {
					status: failure === "http" ? 503 : 200,
				});
			},
			onResponse: () => {
				if (failure === "hook") throw new Error("hook failed");
			},
		});
		expect((await response.result()).stopReason).toBe("error");
		expect(vi.getTimerCount()).toBe(0);
	});
});
