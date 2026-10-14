import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRequest } from "../src/api/antigravity/stream.ts";
import { stream, streamSimple } from "../src/api/antigravity-api.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { antigravityOAuth, parseAntigravityCallback } from "../src/auth/oauth/antigravity.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
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
