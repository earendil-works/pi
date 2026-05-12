import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

// Regression coverage for raw control-character payloads from Codex.
//
// Strict JSON.parse rejects U+0000–U+001F inside string literals, but real
// agent traffic (tool output containing env scans, binary inspection,
// OTP/messaging forwards, etc.) routinely echoes those bytes back through
// the Codex transport. Pre-fix, both the SSE chunk parser and the
// WebSocket frame parser called bare JSON.parse and threw
// CodexProtocolError("Invalid Codex SSE JSON: …" / "…WebSocket JSON: …")
// at the same byte offset on every retry, producing an infinite agent
// retry loop with no recovery path.
//
// The fix routes both parsers through parseJsonWithRepair (already used by
// the Anthropic provider in this package), which escapes raw control chars
// + invalid escapes before re-parsing.

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const codexModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const codexContext: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Echo tool output", timestamp: 1 }],
};

describe("openai-codex JSON-with-control-chars resilience", () => {
	it("accepts SSE chunks whose string literals contain raw control characters", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-controlchar-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();

		// The delta value below contains a literal U+0007 (BEL) and U+001B
		// (ESC) — exactly the byte class that broke strict JSON.parse.
		// We hand-craft the SSE payload because JSON.stringify would escape
		// the control chars; the bug specifically requires the raw bytes to
		// arrive over the wire.
		const dirtyDelta = `before${String.fromCharCode(0x07)}middle${String.fromCharCode(0x1b)}after`;
		const dirtySseEvent = `data: {"type":"response.output_text.delta","delta":"${dirtyDelta}"}`;
		const cleanFinalText = "after";

		const events = [
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			dirtySseEvent,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: cleanFinalText }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		];
		const sse = `${events.join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const result = await Promise.race([
			streamOpenAICodexResponses(codexModel, codexContext, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for dirty SSE stream")), 2000);
			}),
		]);

		// The transport must not throw a CodexProtocolError on a control-char
		// payload. The final content from response.output_item.done is what
		// the agent loop consumes.
		expect(result.content.find((c) => c.type === "text")?.text).toBe(cleanFinalText);
		expect(result.stopReason).toBe("stop");
	});

	it("accepts WebSocket frames whose string literals contain raw control characters", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-controlchar-ws-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();

		global.fetch = vi.fn(async () => new Response("unexpected fetch", { status: 500 })) as typeof fetch;

		// Same shape as the SSE case: a delta event with raw U+0007 + U+001B
		// in its string literal. Hand-built so the bytes survive transport.
		const dirtyDelta = `b${String.fromCharCode(0x07)}m${String.fromCharCode(0x1b)}e`;
		const dirtyFrame = `{"type":"response.output_text.delta","delta":"${dirtyDelta}"}`;
		const cleanFinalText = "Hello";

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(_data: string): void {
				const cleanEvents: unknown[] = [
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				];
				const trailingClean: unknown[] = [
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: cleanFinalText }],
						},
					},
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of cleanEvents) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
					// Send the dirty frame as the raw string — without
					// re-serializing — so the control bytes survive.
					this.dispatch("message", { data: dirtyFrame });
					for (const event of trailingClean) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		const result = await Promise.race([
			streamSimpleOpenAICodexResponses(codexModel, codexContext, {
				apiKey: token,
				sessionId: "session-controlchar",
				transport: "auto",
			}).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for dirty WebSocket stream")), 2000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe(cleanFinalText);
		expect(result.stopReason).toBe("stop");
	});
});
