// gate.ts callGate fetch + JSON parse + retry + timeout (task 2.3).
//
// Tests the full callGate implementation including:
//   - Happy path: successful fetch + valid JSON → correct GateDecision
//   - Prefix garbage: LLM prepends natural language before JSON → still parses
//   - Parse fail: completely invalid JSON → null
//   - Timeout: AbortController fires → null (S6)
//   - Connection refused: fetch throws → null (S7)
//   - Schema invalid: valid JSON but wrong types → null
//   - Extra fields (like search_query) are tolerated → GateDecision still returned
//   - Response missing message: unexpected response shape → null
//
// Mock strategy: vi.spyOn(globalThis, 'fetch') inside each test with
// vi.mocked().mockResolvedValueOnce() / mockRejectedValueOnce(). This keeps
// tests isolated and avoids hoisting complications.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGate, type GateDecision } from "../gate.ts";

// Helper: create a mock Response with the given body and status.
function mockJsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		headers: new Headers({ "content-type": "application/json" }),
	} as Response;
}

describe("callGate fetch + JSON parse + retry + timeout (task 2.3)", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockReset();
		vi.spyOn(console, "warn").mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── S1–S4: Happy path ──────────────────────────────────────────

	it("returns GateDecision on successful fetch with valid JSON (need_memory:true)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":true}' },
			}),
		);
		const result = await callGate("bwa 并发", ["之前的问题"]);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	it("returns GateDecision on successful fetch with valid JSON (need_memory:false)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":false}' },
			}),
		);
		const result = await callGate("对", ["好的", "继续"]);
		expect(result).toEqual({ need_memory: false } satisfies GateDecision);
	});

	// ── S5: Parse fail → "parse" ─────────────────────────────────

	it("returns 'parse' when response content is completely invalid JSON (S5)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: "坏掉的 JSON" },
			}),
		);
		const result = await callGate("hello", []);
		expect(result).toBe("parse");
	});

	// ── S6: Timeout → "timeout" ───────────────────────────────────

	it("returns 'timeout' when fetch times out via AbortController (S6)", async () => {
		// Simulate abort by rejecting with an AbortError (as DOMException does).
		const abortError = new Error("The operation was aborted");
		abortError.name = "AbortError";
		vi.mocked(fetch).mockRejectedValueOnce(abortError);
		const result = await callGate("test", []);
		expect(result).toBe("timeout");
	});

	// ── S7: Connection refused → "unreachable" ────────────────────

	it("returns 'unreachable' when fetch throws (ECONNREFUSED → S7)", async () => {
		const connError = new TypeError("fetch failed");
		vi.mocked(fetch).mockRejectedValueOnce(connError);
		const result = await callGate("test", []);
		expect(result).toBe("unreachable");
	});

	// ── Prefix garbage handling ────────────────────────────────────

	it("parses JSON even when LLM prepends natural language before JSON block", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: {
					content: "一些前缀文字\n{\"need_memory\":false}",
				},
			}),
		);
		const result = await callGate("对", []);
		expect(result).toEqual({ need_memory: false } satisfies GateDecision);
	});

	it("parses JSON when LLM prepends text and JSON has trailing content", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: {
					content: "先思考一下\n{\"need_memory\":true}\n然后继续",
				},
			}),
		);
		const result = await callGate("并发问题", ["之前提过"]);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	// ── Schema validation ──────────────────────────────────────────

	it("returns 'parse' when JSON has wrong types for need_memory (string instead of boolean)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":"not_bool"}' },
			}),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	it("returns 'parse' when need_memory is null (not boolean)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":null}' },
			}),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	it("returns 'parse' when need_memory is missing entirely", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: "{}" },
			}),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	// Task 1.1: GateDecision no longer includes search_query.
	// Extra fields (including search_query) must be tolerated for
	// backward compat with LLM output that still includes them.
	it("tolerates extra fields like search_query in JSON (backward compat)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":true,"search_query":"bwa 并发"}' },
			}),
		);
		const result = await callGate("bwa 并发", ["之前的问题"]);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	// ── Response shape errors ──────────────────────────────────────

	it("returns 'parse' when response has no message property", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({ foo: "bar" }),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	it("returns 'parse' when response message has no content property", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({ message: {} }),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	it("returns 'parse' and warns when response content is empty string", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({ message: { content: "" } }),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
		expect(console.warn).toHaveBeenCalledWith("[gate] empty response from LLM");
	});

	// ── Fetch rejects that should produce null ─────────────────────

	it("returns null when res.json() rejects (unknown error)", async () => {
		const badResponse = {
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("invalid json body");
			},
			headers: new Headers(),
		} as unknown as Response;
		vi.mocked(fetch).mockResolvedValueOnce(badResponse);
		const result = await callGate("test", []);
		expect(result).toBeNull();
	});

	// ── Options passthrough ────────────────────────────────────────

	it("passes url, model, timeoutMs from options to fetch call", async () => {
		const mockFetch = vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":false}' },
			}),
		);
		await callGate("hello", [], {
			ollamaUrl: "http://custom:12345",
			model: "test-model",
			timeoutMs: 1000,
		});
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://custom:12345/api/chat");
		const body = JSON.parse(init!.body as string);
		expect(body.model).toBe("test-model");
	});

	// ── buildGatePrompt is called (indirectly verified by messages) ─

	it("sends messages with system and user role in fetch body", async () => {
		const mockFetch = vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":true}' },
			}),
		);
		const result = await callGate("bwa 并发", ["之前的问题"]);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
		const [, init] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(init!.body as string);
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[1].role).toBe("user");
		expect(body.messages[1].content).toContain("bwa 并发");
	});

	// ── Repair: malformed JSON recovery (2026-07-07 regression) ──
	//
	// qwen2.5:3b at temperature=0 occasionally emits `{"need_memory:true}`
	// — missing closing `}` AND unquoted key. With format: "json" plumbed
	// upstream this should be near-zero frequency, but as defence-in-depth
	// the parser tries a sequence of repairs before giving up. These tests
	// protect the recovery path so a future change cannot silently start
	// treating recoverable outputs as parse-fail.

	it("repairs missing closing brace — {\"need_memory:true}  (unquoted key + missing })", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory:true}' },
			}),
		);
		const result = await callGate("你还记得MGM项目吗", []);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	it("repairs missing closing brace when key IS quoted — {\"need_memory\":true", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":true' },
			}),
		);
		const result = await callGate("之前看过哪个项目", []);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	it("repairs string boolean — {\"need_memory\":\"true\"} → true", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":"true"}' },
			}),
		);
		const result = await callGate("MGM项目工时", []);
		expect(result).toEqual({ need_memory: true } satisfies GateDecision);
	});

	it("repairs string boolean false — {\"need_memory\":\"false\"} → false", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":"false"}' },
			}),
		);
		const result = await callGate("继续", []);
		expect(result).toEqual({ need_memory: false } satisfies GateDecision);
	});

	it("does NOT repair — completely unrecoverable garbage returns 'parse'", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: "不是JSON, 不是注释, 就是乱文本" },
			}),
		);
		const result = await callGate("test", []);
		expect(result).toBe("parse");
	});

	// ── format: "json" header — must be sent to ollama ─────────────
	//
	// `format: "json"` is the upstream defence that constrains ollama to
	// emit syntactically valid JSON. The repair path above is the
	// second line of defence; both must coexist. If a future refactor
	// accidentally drops `format`, this test fires.

	it("sends format: 'json' to ollama /api/chat (source-level JSON constraint)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockJsonResponse({
				message: { content: '{"need_memory":false}' },
			}),
		);
		await callGate("hello", []);
		const [, init] = vi.mocked(fetch).mock.calls[0]!;
		const body = JSON.parse(init!.body as string);
		expect(body.format).toBe("json");
	});
});
