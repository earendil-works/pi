import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointCandidates } from "../src/api/antigravity/client.ts";
import { getThinkingConfig } from "../src/api/antigravity/models.ts";
import { assertSafeApiBaseUrl } from "../src/api/antigravity/security.ts";
import {
	buildRequest,
	convertMessages,
	convertTools,
	friendlyAntigravityError,
	requiresThoughtSignature,
	SKIP_THOUGHT_SIGNATURE_VALIDATOR,
} from "../src/api/antigravity/stream.ts";
import { stream, streamSimple } from "../src/api/antigravity-api.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { antigravityOAuth, parseAntigravityCallback } from "../src/auth/oauth/antigravity.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const credential: OAuthCredential = {
	type: "oauth",
	access: "fake-access",
	refresh: "fake-refresh",
	expires: Date.now() + 3600_000,
	projectId: "test-project",
};
const context = normalizeContext({
	systemPrompt: "Be concise.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
});
const apiKey = JSON.stringify({ token: credential.access, projectId: credential.projectId });
const model = antigravityProvider()
	.getModels()
	.find((model) => model.id === "gemini-3.7-flash")!;

function response(parts: unknown[] = [{ text: "native-ok" }], finishReason = "STOP") {
	return new Response(
		`data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, finishReason }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 12 } } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("native Antigravity", () => {
	it.each([
		["gemini-3.7-flash", undefined],
		["gemini-3.7-flash", "YWJjZA=="],
		["gemini-3.7-flash", "invalid"],
		["claude-opus-4-6", "YWJjZA=="],
	] as const)("preserves structured tool history from %s with signature %s", (sourceModel, signature) => {
		const history = normalizeContext({
			messages: [
				{ role: "user", content: "Read it", timestamp: 1 },
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: sourceModel,
					content: [
						{
							type: "toolCall",
							id: "call/1",
							name: "read",
							arguments: { path: "a.txt" },
							thoughtSignature: signature,
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call/1",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 3,
				},
			],
		});
		expect(convertMessages(model, history, "gemini-3.7-flash-low")).toEqual([
			{ role: "user", parts: [{ text: "Read it" }] },
			{
				role: "model",
				parts: [
					{
						functionCall: { name: "read", args: { path: "a.txt" }, id: "call_1" },
						thoughtSignature:
							sourceModel === model.id && signature === "YWJjZA=="
								? signature
								: SKIP_THOUGHT_SIGNATURE_VALIDATOR,
					},
				],
			},
			{
				role: "user",
				parts: [{ functionResponse: { name: "read", response: { output: "contents" }, id: "call_1" } }],
			},
		]);
	});

	it.each([false, true])("preserves literal unions in tool parameters (legacy=%s)", (legacy) => {
		const tools = convertTools(
			[
				{
					name: "pick",
					description: "Pick",
					parameters: Type.Object({ choice: Type.Union([Type.Literal("red"), Type.Literal("blue")]) }),
				},
			],
			legacy,
		);
		expect(JSON.parse(JSON.stringify(tools?.[0].functionDeclarations[0]))).toEqual({
			name: "pick",
			description: "Pick",
			[legacy ? "parameters" : "parametersJsonSchema"]: {
				type: "object",
				properties: { choice: { type: "string", enum: ["red", "blue"] } },
				required: ["choice"],
			},
		});
	});

	it("keeps skill text in its original user turn", async () => {
		const text = 'Read <skill name="test">literal instructions</skill> then continue.';
		const request = await buildRequest(
			model,
			normalizeContext({ systemPrompt: "System", messages: [{ role: "user", content: text, timestamp: 1 }] }),
			"project",
			{},
			"gemini-3.7-flash-low",
		);
		expect(request.request.contents).toEqual([{ role: "user", parts: [{ text }] }]);
		expect(request.request.systemInstruction).toEqual({ role: "user", parts: [{ text: "System" }] });
	});
	it("is a built-in provider without any extension", () => {
		const models = builtinModels();
		expect(models.getModel("antigravity", "gemini-3.7-flash")?.api).toBe("antigravity-api");
		expect(models.getProvider("antigravity")?.auth.oauth?.isSubscription).toBe(true);
	});

	it.each([stream, streamSimple])("supports both direct API entry points and request hooks", async (call) => {
		const order: string[] = [];
		let body: Record<string, unknown> | undefined;
		const result = await call(model, context, {
			apiKey,
			reasoning: "high",
			headers: { "X-Custom": "value", "User-Agent": null },
			onPayload: (payload) => {
				order.push("payload");
				return { ...(payload as object), testMarker: true };
			},
			onResponse: (incoming) => {
				order.push("response");
				expect(incoming.status).toBe(200);
				expect(incoming.headers["content-type"]).toBe("text/event-stream");
			},
			onProviderStreamEvent: async () => {
				order.push("event");
			},
			fetch: async (url, init) => {
				order.push("fetch");
				expect(String(url)).toContain("streamGenerateContent?alt=sse");
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer fake-access");
				expect(headers.get("x-custom")).toBe("value");
				expect(headers.has("user-agent")).toBe(false);
				body = JSON.parse(String(init?.body));
				return response();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "native-ok" });
		expect(body).toMatchObject({
			project: "test-project",
			model: "gemini-3.7-flash-high",
			testMarker: true,
			request: { systemInstruction: { parts: [{ text: "Be concise." }] } },
		});
		expect(result.usage).toMatchObject({ input: 7, cacheRead: 3, output: 2, totalTokens: 12 });
		expect(order).toEqual(["payload", "fetch", "response", "event"]);
	});

	it("resolves existing extension credentials through Models", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("antigravity", async () => credential);
		const models = createModels({ credentials });
		models.setProvider(antigravityProvider());
		const result = await models.completeSimple(model, context, { fetch: async () => response() });
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ text: "native-ok" });
	});

	it("refreshes expired credentials and preserves the project and refresh token", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("antigravity", async () => ({ ...credential, expires: 1 }));
		const previousDispatcher = getGlobalDispatcher();
		const mock = new MockAgent();
		mock.disableNetConnect();
		setGlobalDispatcher(mock);
		vi.stubGlobal("fetch", () => {
			throw new Error("OAuth must use Undici fetch");
		});
		try {
			mock
				.get("https://oauth2.googleapis.com")
				.intercept({ path: "/token", method: "POST", body: /refresh_token=fake-refresh/ })
				.reply(200, { access_token: "fresh-access", expires_in: 3600 });
			const models = createModels({ credentials });
			models.setProvider(antigravityProvider());
			const auth = await models.getAuth("antigravity");
			expect(JSON.parse(auth!.auth.apiKey!)).toEqual({ token: "fresh-access", projectId: "test-project" });
			expect(await credentials.read("antigravity")).toMatchObject({
				refresh: "fake-refresh",
				access: "fresh-access",
				projectId: "test-project",
			});
			mock.assertNoPendingInterceptors();
		} finally {
			setGlobalDispatcher(previousDispatcher);
			await mock.close();
		}
	});

	it("does not refresh an already aborted request", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		controller.abort();
		await expect(antigravityOAuth.refresh(credential, controller.signal)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects a pasted callback from another login", () => {
		expect(() =>
			parseAntigravityCallback("http://localhost:51121/oauth-callback?code=secret&state=wrong", "expected"),
		).toThrow("state mismatch");
		expect(
			parseAntigravityCallback("http://localhost:51121/oauth-callback?code=secret&state=expected", "expected"),
		).toBe("secret");
	});

	it("streams signed tool calls and replays their results", async () => {
		const result = await streamSimple(model, context, {
			apiKey,
			fetch: async () =>
				response([
					{ functionCall: { name: "echo", args: { text: "hello" }, id: "call1" }, thoughtSignature: "YWJjZA==" },
				]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "echo",
			arguments: { text: "hello" },
			thoughtSignature: "YWJjZA==",
		});
		const next = normalizeContext({
			messages: [
				...context.messages,
				result,
				{
					role: "toolResult",
					toolCallId: "call1",
					toolName: "echo",
					content: [{ type: "text", text: "hello" }],
					isError: false,
					timestamp: 2,
				},
			],
		});
		const request = await buildRequest(model, next, "test-project", {}, "gemini-3.7-flash-low");
		expect(JSON.stringify(request.request.contents)).toContain("functionResponse");
		expect(JSON.stringify(request.request.contents)).toContain("YWJjZA==");
	});

	it.each([
		["MAX_TOKENS", "length"],
		["SAFETY", "error"],
		["MALFORMED_FUNCTION_CALL", "error"],
	])("does not promote %s into tool execution", async (finish, expected) => {
		const result = await streamSimple(model, context, {
			apiKey,
			fetch: async () => response([{ functionCall: { name: "echo", args: {} } }], finish),
		}).result();
		expect(result.stopReason).toBe(expected);
	});

	it.each(["", "data: invalid\n\n"])("rejects a truncated or malformed terminal event: %s", async (tail) => {
		const partial = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}\n\n`;
		const result = await streamSimple(model, context, {
			apiKey,
			fetch: async () => new Response(partial + tail),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.content[0]).toMatchObject({ text: "partial" });
	});

	it("consumes the final event even without a trailing newline", async () => {
		const result = await streamSimple(model, context, {
			apiKey,
			fetch: async () => new Response((await response().text()).trimEnd()),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ text: "native-ok" });
	});

	it.each(["onResponse", "onProviderStreamEvent"] as const)("cancels an open body when %s throws", async (hook) => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"candidates":[]}\n\n'));
			},
			cancel,
		});
		const result = await streamSimple(model, context, {
			apiKey,
			fetch: async () => new Response(body),
			[hook]: () => {
				throw new Error("hook failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("hook failed");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});

	it("merges model headers before case-insensitive request overrides and null suppression", async () => {
		const result = await streamSimple(
			{ ...model, headers: { "X-Model": "keep", "X-Override": "old", "X-Drop": "old" } },
			context,
			{
				apiKey,
				headers: { "x-override": "new", "x-drop": null },
				fetch: async (_url, init) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("x-model")).toBe("keep");
					expect(headers.get("x-override")).toBe("new");
					expect(headers.has("x-drop")).toBe(false);
					return response();
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
	});

	it("returns a terminal error without fetching when credentials are missing", async () => {
		const fetch = vi.fn();
		const result = await streamSimple(model, context, { fetch }).result();
		expect(result.stopReason).toBe("error");
		expect(fetch).not.toHaveBeenCalled();
	});

	// Upstream pi-antigravity #59 (v0.8.0) removed unref from the stall watchdog.
	it("keeps a standalone process alive until a stalled body is rejected", () => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/antigravity-stall.ts", import.meta.url))],
			{ encoding: "utf8", timeout: 5000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("stream stalled: no data for 10ms");
	});

	it("honors cancellation during the request", async () => {
		const controller = new AbortController();
		const pending = streamSimple(model, context, {
			apiKey,
			signal: controller.signal,
			fetch: async (_url, init) => {
				controller.abort();
				init?.signal?.throwIfAborted();
				return response();
			},
		}).result();
		expect((await pending).stopReason).toBe("aborted");
	});
});

describe("antigravity 429 classification", () => {
	const asError = (text: string) =>
		({
			stopReason: "error",
			errorMessage: `Antigravity API error (429, runtimeModel=gemini-4-argon-low): ${friendlyAntigravityError(429, text)}`,
		}) as Parameters<typeof isRetryableAssistantError>[0];

	it.each([
		"Individual quota reached for this model. Resets in 3h 12m.",
		"You have exceeded your daily limit. Resets in 1h.",
	])("does not retry a quota wall: %s", (text) => {
		expect(isRetryableAssistantError(asError(text))).toBe(false);
	});

	it.each(["Resource has been exhausted (e.g. check quota).", "rate limit exceeded, slow down"])(
		"retries transient throttling: %s",
		(text) => {
			expect(isRetryableAssistantError(asError(text))).toBe(true);
		},
	);
});

describe("Claude thinking config", () => {
	// Probe 2026-10-24: the bridge ignores thinkingConfig for Claude; the runtime id carries effort.
	it.each([undefined, "off", "low", "medium", "high", "xhigh"])("sends no thinkingConfig at effort %s", (effort) => {
		expect(getThinkingConfig({ ...model, id: "claude-sonnet-5-5" }, effort)).toBeUndefined();
		expect(getThinkingConfig({ ...model, id: "claude-opus-5-5" }, effort)).toBeUndefined();
	});

	it("omits generationConfig.thinkingConfig on the wire for a Claude runtime", async () => {
		const claude = antigravityProvider()
			.getModels()
			.find((m) => m.id === "claude-sonnet-5-5")!;
		const request = await buildRequest(claude, context, "project", { reasoning: "high" }, "claude-sonnet-5-5-high");
		expect(request.request.generationConfig?.thinkingConfig).toBeUndefined();
		expect(JSON.stringify(request.request)).not.toContain("thinkingBudget");
	});
});

describe("Gemini 4 Argon thinking config", () => {
	it("omits thinkingConfig for off and undefined instead of sending a zero budget", () => {
		expect(getThinkingConfig({ ...model, id: "gemini-4-argon-low" }, "off")).toBeUndefined();
		expect(getThinkingConfig({ ...model, id: "gemini-4-argon-low" }, undefined)).toBeUndefined();
	});

	it.each(["low", "medium", "high"])("uses a thinking level for %s", (effort) => {
		expect(getThinkingConfig({ ...model, id: `gemini-4-argon-${effort}` }, effort)).toEqual({
			includeThoughts: true,
			thinkingLevel: effort.toUpperCase(),
		});
	});
});

describe("request-time guards", () => {
	it("omits thinkingConfig entirely for a model the catalog marks non-thinking", async () => {
		const plain = { ...model, reasoning: false };
		const request = await buildRequest(plain, context, "test-project", { reasoning: "low" }, "gemini-3.7-flash-low");
		expect(request.request.generationConfig?.thinkingConfig).toBeUndefined();
		const thinking = await buildRequest(model, context, "test-project", { reasoning: "low" }, "gemini-3.7-flash-low");
		expect(thinking.request.generationConfig?.thinkingConfig).toBeDefined();
	});

	it("clamps a caller-supplied maxTokens to the model's advertised output limit", async () => {
		const small = { ...model, maxTokens: 1000 };
		const request = await buildRequest(small, context, "test-project", { maxTokens: 50_000 }, "gemini-3.7-flash-low");
		expect(request.request.generationConfig?.maxOutputTokens).toBe(1000);
		const unchanged = await buildRequest(small, context, "test-project", { maxTokens: 500 }, "gemini-3.7-flash-low");
		expect(unchanged.request.generationConfig?.maxOutputTokens).toBe(500);
	});
});

describe("Antigravity base URL guard", () => {
	it("accepts plain-http loopback proxies", () => {
		expect(assertSafeApiBaseUrl("http://127.0.0.1:20128/direct/cloudcode/")).toBe(
			"http://127.0.0.1:20128/direct/cloudcode",
		);
		expect(assertSafeApiBaseUrl("http://localhost:20128")).toBe("http://localhost:20128");
		expect(assertSafeApiBaseUrl("http://[::1]:20128/direct/cloudcode")).toBe("http://[::1]:20128/direct/cloudcode");
		expect(endpointCandidates(undefined, "http://127.0.0.1:20128/direct/cloudcode")).toEqual([
			"http://127.0.0.1:20128/direct/cloudcode",
		]);
	});

	it("still rejects plain http off loopback, credentials, and non-Google https hosts", () => {
		expect(() => assertSafeApiBaseUrl("http://192.168.1.5:20128")).toThrow(/must use https/);
		expect(() => assertSafeApiBaseUrl("http://daily-cloudcode-pa.googleapis.com")).toThrow(/must use https/);
		expect(() => assertSafeApiBaseUrl("http://user:pass@127.0.0.1:20128")).toThrow(/credentials/);
		expect(() => assertSafeApiBaseUrl("https://evil.example.com")).toThrow(/not allowed/);
		expect(assertSafeApiBaseUrl("https://daily-cloudcode-pa.googleapis.com/")).toBe(
			"https://daily-cloudcode-pa.googleapis.com",
		);
	});
});

describe("Gemini 3 Flash thinking config", () => {
	it("omits thinkingConfig at off (the backend rejects thinkingBudget 0; minThinkingBudget is 32)", () => {
		expect(getThinkingConfig({ ...model, id: "gemini-3-flash" }, "off")).toBeUndefined();
		expect(getThinkingConfig({ ...model, id: "gemini-3-flash" }, undefined)).toBeUndefined();
	});

	it("uses thinking levels for the other levels", () => {
		expect(getThinkingConfig({ ...model, id: "gemini-3-flash" }, "low")).toEqual({
			includeThoughts: true,
			thinkingLevel: "LOW",
		});
		expect(getThinkingConfig({ ...model, id: "gemini-3-flash" }, "high")).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});
});

it.each(["gemini-3.8-flash", "gemini-4-argon", "gemini-3.1-pro"])(
	"pins discrete thinking wire config for %s",
	async (id) => {
		const current = antigravityProvider()
			.getModels()
			.find((m) => m.id === id)!;
		for (const effort of ["low", "medium", "high"] as const) {
			const request = await buildRequest(current, context, "project", { reasoning: effort }, id);
			const expectedLevel = id === "gemini-3.1-pro" && effort === "medium" ? "HIGH" : effort.toUpperCase();
			expect(request.request.generationConfig?.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingLevel: expectedLevel,
			});
		}
		const off = await buildRequest(current, context, "project", {}, id);
		expect(JSON.stringify(off.request.generationConfig)).not.toContain('"thinkingBudget":0');
		if (id === "gemini-4-argon") expect(off.request.generationConfig?.thinkingConfig).toBeUndefined();
	},
);

describe("antigravity convertMessages — unsigned tool calls on the bridge", () => {
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const history = (target: { api: string; provider: string; id: string }, source: string, thoughtSignature?: string) =>
		normalizeContext({
			messages: [
				{ role: "user", content: "Hi", timestamp: 1 },
				{
					role: "assistant",
					api: target.api,
					provider: target.provider,
					model: source,
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "bash",
							arguments: { command: "echo hi" },
							...(thoughtSignature && { thoughtSignature }),
						},
						{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "ls -la" } },
					],
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "hi" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "bash",
					content: [{ type: "text", text: "files" }],
					isError: false,
					timestamp: 4,
				},
			],
		});
	const functionCalls = (contents: ReturnType<typeof convertMessages>) =>
		contents
			.flatMap((c) => c.parts)
			.filter((p): p is Extract<typeof p, { functionCall: unknown }> => "functionCall" in p);

	it.each(["gemini-3.8-flash", "gemini-4-argon", "gemini-pro-agent"])(
		"adds the validator bypass to every unsigned call for %s",
		(id) => {
			const target = { ...model, id };
			const calls = functionCalls(convertMessages(target, history(target, "claude-sonnet-5-5"), id));
			expect(calls.map((p) => p.functionCall.id)).toEqual(["call_1", "call_2"]);
			expect(calls.map((p) => p.thoughtSignature)).toEqual([
				SKIP_THOUGHT_SIGNATURE_VALIDATOR,
				SKIP_THOUGHT_SIGNATURE_VALIDATOR,
			]);
			expect(JSON.stringify(convertMessages(target, history(target, "claude-sonnet-5-5"), id))).not.toContain(
				"Historical context",
			);
		},
	);

	it("keeps a valid same-model signature and bypasses only the unsigned sibling", () => {
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const calls = functionCalls(convertMessages(model, history(model, model.id, validSig), "gemini-3.7-flash-low"));
		expect(calls.map((p) => p.thoughtSignature)).toEqual([validSig, SKIP_THOUGHT_SIGNATURE_VALIDATOR]);
	});

	it("treats a same-model call whose signature was lost like a foreign one", () => {
		const calls = functionCalls(
			convertMessages(model, history(model, model.id, "not base64!"), "gemini-3.7-flash-low"),
		);
		expect(calls.map((p) => p.thoughtSignature)).toEqual([
			SKIP_THOUGHT_SIGNATURE_VALIDATOR,
			SKIP_THOUGHT_SIGNATURE_VALIDATOR,
		]);
	});

	it.each(["claude-sonnet-5-5", "gpt-oss-120b"])("never adds a signature for the %s runtime", (id) => {
		const target = { ...model, id };
		const calls = functionCalls(convertMessages(target, history(target, "gemini-3.8-flash"), `${id}-high`));
		expect(calls).toHaveLength(2);
		expect(calls.every((p) => p.thoughtSignature === undefined)).toBe(true);
		expect(calls.map((p) => p.functionCall.id)).toEqual(["call_1", "call_2"]);
	});

	it.each([
		[true, "gemini-3-flash"],
		[true, "gemini-3.8-flash-low"],
		[true, "gemini-4-argon-high"],
		[true, "gemini-pro-agent"],
		[false, "gemini-2.5-flash"],
		[false, "claude-opus-5-5-high"],
		[false, "gpt-oss-120b-medium"],
	] as const)("requiresThoughtSignature returns %s for %s", (expected, id) => {
		expect(requiresThoughtSignature(id)).toBe(expected);
	});
});
