import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/ollama-chat.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { normalizeOllamaUrl, ollamaProvider } from "../src/providers/ollama.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"ollama-chat"> = {
	id: "test:small",
	name: "test",
	provider: "ollama",
	api: "ollama-chat",
	baseUrl: "http://localhost:11434",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 4096,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
const terminal = {
	done: true,
	done_reason: "stop",
	prompt_eval_count: 100,
	prompt_eval_cached_count: 30,
	eval_count: 4,
};

function ndjson(records: unknown[], size = 10000): Response {
	const bytes = new TextEncoder().encode(records.map((record) => JSON.stringify(record)).join("\n"));
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
				controller.close();
			},
		}),
	);
}

describe("native Ollama transport", () => {
	it.each([1, 2, 3, 7, 64, 10000])("handles UTF-8 and NDJSON split into %i-byte chunks", async (size) => {
		const response = stream(model, context, {
			fetch: async () =>
				ndjson([{ message: { thinking: "考虑" } }, { message: { content: "Hello 🌍" } }, terminal], size),
		});
		const events = [];
		for await (const event of response) events.push(event.type);
		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(await response.result()).toMatchObject({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "考虑" },
				{ type: "text", text: "Hello 🌍" },
			],
			usage: { input: 70, cacheRead: 30, output: 4, totalTokens: 104 },
		});
	});

	it("controls context, output, thinking, sampling, and header tombstones", async () => {
		let payload: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const response = await streamSimple({ ...model, samplingParams: { top_k: 30 } }, context, {
			maxTokens: 64,
			temperature: 0.2,
			apiKey: "secret",
			headers: { Authorization: null, "x-test": "yes" },
			samplingParams: { top_k: 20, num_ctx: 999999, num_predict: -1 },
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body));
				headers = new Headers(init?.headers);
				return ndjson([terminal]);
			},
		}).result();
		expect(response.stopReason).toBe("stop");
		expect(payload).toMatchObject({
			stream: true,
			think: false,
			truncate: false,
			shift: false,
			options: { num_ctx: 4096, num_predict: 64, top_k: 20, temperature: 0.2 },
		});
		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.get("x-test")).toBe("yes");
	});

	it("uses the lazy provider transport with a factory-supplied fetch", async () => {
		const fetch = vi.fn<FetchFunction>(async () => ndjson([{ message: { content: "local reply" } }, terminal]));
		const provider = ollamaProvider({ baseUrl: model.baseUrl, fetch });
		expect(fetch).not.toHaveBeenCalled();
		const response = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "local reply" }]);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ think: true });
	});

	it("maps required thinking to an effort value even when reasoning is omitted", async () => {
		const payloads: unknown[] = [];
		const required: Model<"ollama-chat"> = {
			...model,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" },
		};
		for (const reasoning of [undefined, "minimal", "medium"] as const) {
			await streamSimple(required, context, {
				reasoning,
				fetch: async (_url, init) => {
					payloads.push(JSON.parse(String(init?.body)));
					return ndjson([terminal]);
				},
			}).result();
		}
		expect(payloads).toMatchObject([{ think: "low" }, { think: "low" }, { think: "medium" }]);
	});

	it("replays parallel tool calls, results, images, and same-model thinking", async () => {
		const call = { function: { name: "read", arguments: { path: "file" } } };
		const first = await stream(model, context, {
			fetch: async () => ndjson([{ message: { thinking: "inspect", tool_calls: [call, call] } }, terminal]),
		}).result();
		expect(first.stopReason).toBe("toolUse");
		const calls = first.content.filter((block) => block.type === "toolCall");
		expect(new Set(calls.map((block) => block.id)).size).toBe(2);
		let payload: { messages: unknown[] } | undefined;
		await stream(
			model,
			normalizeContext({
				messages: [
					context.messages[0],
					first,
					...calls.map((tool) => ({
						role: "toolResult" as const,
						toolCallId: tool.id,
						toolName: tool.name,
						content: [
							{ type: "text" as const, text: "result" },
							{ type: "image" as const, data: "YWJj", mimeType: "image/png" },
						],
						isError: false,
						timestamp: 2,
					})),
				],
			}),
			{
				fetch: async (_url, init) => {
					payload = JSON.parse(String(init?.body));
					return ndjson([terminal]);
				},
			},
		).result();
		expect(payload?.messages[1]).toMatchObject({
			role: "assistant",
			thinking: "inspect",
			tool_calls: calls.map((tool) => ({ id: tool.id, function: { name: "read", arguments: { path: "file" } } })),
		});
		expect(payload?.messages[2]).toMatchObject({
			role: "tool",
			tool_name: "read",
			tool_call_id: calls[0].id,
			images: ["YWJj"],
		});
	});

	it.each(
		[
			[{ message: { content: "partial" } }],
			[{ message: { tool_calls: [{ function: { name: "write", arguments: {} } }] } }, { error: "runner crashed" }],
			[{ message: { tool_calls: [{ function: { name: "write", arguments: "not an object" } }] } }, terminal],
			[{ done: true, done_reason: "unknown" }],
		].map((records) => ({ records })),
	)("fails incomplete or invalid response %# without successful termination", async ({ records }) => {
		const response = stream(model, context, { fetch: async () => ndjson(records) });
		const events = [];
		for await (const event of response) events.push(event.type);
		expect((await response.result()).stopReason).toBe("error");
		expect(events).not.toContain("done");
		expect(events.at(-1)).toBe("error");
	});

	it("recognizes the real native overflow response", async () => {
		const response = await stream(model, context, {
			fetch: async () => Response.json({ error: "the input length exceeds the context length" }, { status: 400 }),
		}).result();
		expect(isContextOverflow(response)).toBe(true);
	});

	it("cancels an active request and releases its reader", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const response = stream(model, context, {
			signal: controller.signal,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(output) {
							output.enqueue(new TextEncoder().encode('{"message":{"content":"partial"}}\n'));
						},
						cancel,
					}),
				),
		});
		for await (const event of response) if (event.type === "text_delta") controller.abort();
		expect((await response.result()).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("does not send tools for toolChoice none and downgrades images for a text-only target", async () => {
		let payload: Record<string, unknown> | undefined;
		await streamSimple(
			{ ...model, input: ["text"] },
			normalizeContext({
				messages: [
					{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 },
				],
				tools: [{ name: "read", description: "read", parameters: Type.Object({}) }],
			}),
			{
				toolChoice: "none",
				fetch: async (_url, init) => {
					payload = JSON.parse(String(init?.body));
					return ndjson([terminal]);
				},
			},
		).result();
		expect(payload).not.toHaveProperty("tools");
		expect(payload?.messages).toEqual([{ role: "user", content: "(image omitted: model does not support images)" }]);
	});
	it("replays system sections and tool changes from the current transcript API", async () => {
		const obsolete = { name: "old", description: "removed", parameters: Type.Object({}) };
		const original = { name: "read", description: "old schema", parameters: Type.Object({ oldPath: Type.String() }) };
		const updated = { name: "read", description: "current schema", parameters: Type.Object({ path: Type.String() }) };
		let payload: { messages: unknown[]; tools: unknown[] } | undefined;
		const response = await stream(
			model,
			normalizeContext({
				messages: [
					{
						role: "system",
						content: "Base instructions",
						sections: { rules: "old rules", temporary: "remove me" },
						toolsAdded: [obsolete, original],
						timestamp: 0,
					},
					context.messages[0],
					{
						role: "system",
						content: "New instruction",
						sections: { rules: "current rules", temporary: null },
						toolsRemoved: [{ name: "old" }],
						toolsAdded: [updated],
						timestamp: 2,
					},
				],
			}),
			{
				fetch: async (_url, init) => {
					payload = JSON.parse(String(init?.body));
					return ndjson([terminal]);
				},
			},
		).result();
		expect(response.stopReason).toBe("stop");
		expect(payload?.messages).toEqual([
			{ role: "system", content: "Base instructions\n\nNew instruction\n\ncurrent rules" },
			{ role: "user", content: "Hello" },
		]);
		expect(payload?.tools).toEqual([{ type: "function", function: updated }]);
	});
});

describe("Ollama discovery", () => {
	const authContext = { env: async () => undefined, fileExists: async () => false };
	function catalogFetch(): FetchFunction {
		return vi.fn(async (input, init) => {
			const path = String(input);
			if (path.endsWith("/version")) return Response.json({ version: "0.20.0" });
			if (path.endsWith("/tags"))
				return Response.json({
					models: ["chat", "saved", "embedding", "cloud"].map((name) => ({ name, digest: name })),
				});
			const { model: name } = JSON.parse(String(init?.body));
			return Response.json({
				capabilities: name === "embedding" ? ["embedding"] : ["completion", "thinking", "vision"],
				parameters: name === "saved" ? "num_ctx 16384" : "",
				model_info: { "qwen.context_length": 262144 },
				...(name === "cloud" ? { remote_host: "https://ollama.com" } : {}),
			});
		});
	}
	it("discovers local chat models without a dummy key or allocating trained context", async () => {
		const models = createModels({ authContext });
		models.setProvider(ollamaProvider({ baseUrl: model.baseUrl, fetch: catalogFetch() }));
		expect((await models.refresh()).errors.size).toBe(0);
		expect((await models.getAuth("ollama"))?.auth).toEqual({ baseUrl: model.baseUrl, apiKey: undefined });
		expect(models.getModels().map((entry) => [entry.id, entry.contextWindow])).toEqual([
			["chat", 8192],
			["saved", 16384],
		]);
		expect(await models.getAvailable()).toHaveLength(2);
	});
	it("restores only the configured endpoint's cache without fetching", async () => {
		const modelsStore = new InMemoryModelsStore();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama", async () => ({ type: "api_key", env: { OLLAMA_BASE_URL: model.baseUrl } }));
		const models = createModels({ authContext, modelsStore, credentials });
		const fetch = catalogFetch();
		models.setProvider(ollamaProvider({ fetch }));
		await models.refresh();
		vi.mocked(fetch).mockClear();
		models.setProvider(ollamaProvider({ fetch }));
		await models.refresh({ allowNetwork: false });
		expect(models.getModels()).toHaveLength(2);
		await credentials.modify("ollama", async () => ({
			type: "api_key",
			env: { OLLAMA_BASE_URL: "http://different:11434" },
		}));
		await models.refresh({ allowNetwork: false });
		expect(models.getModels()).toHaveLength(0);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not probe unconfigured servers and rejects unsupported versions", async () => {
		const fetch = vi.fn<FetchFunction>(async () => Response.json({ version: "0.19.0" }));
		const models = createModels({ authContext });
		models.setProvider(ollamaProvider({ fetch }));
		await models.refresh();
		expect(fetch).not.toHaveBeenCalled();
		models.setProvider(ollamaProvider({ baseUrl: model.baseUrl, fetch }));
		expect((await models.refresh()).errors.get("ollama")?.message).toContain("0.20");
	});
	it("keeps the last catalog on failure and replaces it after models change", async () => {
		const fetch = catalogFetch();
		const models = createModels({ authContext });
		models.setProvider(ollamaProvider({ baseUrl: model.baseUrl, fetch }));
		await models.refresh();
		vi.mocked(fetch).mockRejectedValueOnce(new Error("server unavailable"));
		expect((await models.refresh()).errors.get("ollama")?.message).toBe("server unavailable");
		expect(models.getModels()).toHaveLength(2);
		vi.mocked(fetch).mockImplementation(async (input) =>
			String(input).endsWith("/version") ? Response.json({ version: "0.20.0" }) : Response.json({ models: [] }),
		);
		await models.refresh();
		expect(models.getModels()).toHaveLength(0);
	});
	it("does not let a late refresh restore a previous endpoint", async () => {
		let currentEndpoint = "http://old:11434";
		let started!: () => void;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refreshing = new Promise<void>((resolve) => {
			started = resolve;
		});
		const normal = catalogFetch();
		const fetch: FetchFunction = async (input, init) => {
			if (String(input) === "http://old:11434/api/version") {
				started();
				await pending;
			}
			return normal(input, init);
		};
		const models = createModels({
			authContext: { ...authContext, env: async (key) => (key === "OLLAMA_BASE_URL" ? currentEndpoint : undefined) },
		});
		models.setProvider(ollamaProvider({ fetch }));
		const old = models.refresh();
		await refreshing;
		currentEndpoint = "http://new:11434";
		await models.refresh();
		release();
		await old;
		expect(models.getModels()).toHaveLength(2);
		expect(models.getModels().every((entry) => entry.baseUrl === currentEndpoint)).toBe(true);
	});
	it("uses endpoint precedence and an environment proxy key for discovery", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama", async () => ({
			type: "api_key",
			env: { OLLAMA_BASE_URL: "http://stored:11434" },
		}));
		const normal = catalogFetch();
		const endpoints: string[] = [];
		const fetch: FetchFunction = async (input, init) => {
			endpoints.push(String(input));
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer proxy-key");
			return normal(input, init);
		};
		const env: Record<string, string> = {
			OLLAMA_BASE_URL: "http://environment:11434",
			OLLAMA_HOST: "http://fallback:11434",
			OLLAMA_API_KEY: "proxy-key",
		};
		const models = createModels({ credentials, authContext: { ...authContext, env: async (key) => env[key] } });
		models.setProvider(ollamaProvider({ fetch }));
		expect((await models.refresh()).errors.size).toBe(0);
		expect(endpoints.every((url) => url.startsWith("http://stored:11434/"))).toBe(true);
	});
	it.each([
		["localhost:11434/", "http://localhost:11434"],
		["http://[::1]:11434/api/", "http://[::1]:11434"],
		["https://example.test/ollama/v1", "https://example.test/ollama"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeOllamaUrl(input)).toBe(expected);
	});
});
