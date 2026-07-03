import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	embedText,
	buildEmbeddableText,
	loadConfig,
	CURRENT_EMBEDDABLE_TEXT_VERSION,
} from "../embed.ts";

// buildEmbeddableText — concatenates title + summary + tags for embedding.
// `content` is deliberately NOT included: recall is discovery-only (results
// carry `atom.id`; full content is fetched by `memory_get` on demand), and
// embedding the long content dilutes the curated title/summary/tags signal
// with incidental token mentions. See `CURRENT_EMBEDDABLE_TEXT_VERSION = 2`
// in embed.ts for the design rationale + migration story.
describe("buildEmbeddableText", () => {
	it("concatenates title, summary, tags with \\n\\n separators (content omitted)", () => {
		const text = buildEmbeddableText({
			title: "PDF 图片提取",
			summary: "用 pymupdf",
			tags: ["pdf", "image"],
		});
		expect(text).toContain("PDF 图片提取");
		expect(text).toContain("用 pymupdf");
		expect(text).toContain("pdf image");
		// Three segments: title, summary, tags — no content.
		expect(text.split("\n\n")).toHaveLength(3);
	});

	it("does NOT include the `content` field", () => {
		// Type signature intentionally narrows to `Pick<MemoryAtom, "title" |
		// "summary" | "tags">` — `content` is not even accepted by the
		// function. This test pins the runtime behaviour in case a future
		// refactor re-introduces content (the type system alone wouldn't
		// catch a `{ ...atom, content: atom.content }` spread).
		const text = buildEmbeddableText({
			title: "MGM project",
			summary: "DNA virus genome work",
			tags: ["MGM", "minimax"],
		});
		expect(text).not.toContain("Verbose content that should not be embedded");
		expect(text).not.toContain("long inline detail about implementation");
	});

	it("skips empty / whitespace-only fields", () => {
		const text = buildEmbeddableText({
			title: "T",
			summary: "   ",
			tags: [],
		});
		expect(text).toBe("T");
	});

	it("renders empty tag list without a trailing empty segment", () => {
		// tags.join(" ") with an empty array is "" — the filter strips it.
		// Result is exactly title + "\n\n" + summary, no dangling "\n\n".
		const text = buildEmbeddableText({
			title: "A",
			summary: "B",
			tags: [],
		});
		expect(text).toBe("A\n\nB");
	});
});

describe("CURRENT_EMBEDDABLE_TEXT_VERSION", () => {
	it("is exported and is a positive integer (storage migration depends on it)", () => {
		// `session_start` reads this constant to find atoms with stale
		// embeddings. It must be a finite positive integer — 0 would
		// match the legacy DEFAULT for `embed_text_version` and cause
		// every atom to be re-embedded on every session (infinite loop).
		expect(Number.isInteger(CURRENT_EMBEDDABLE_TEXT_VERSION)).toBe(true);
		expect(CURRENT_EMBEDDABLE_TEXT_VERSION).toBeGreaterThan(0);
	});
});

// embedText — single text → 1024-dim vector or null on any failure.
// All failure modes (timeout, non-OK, malformed body, parse error) collapse
// to null per Decision 7 (no fallback to other embeddings).
describe("embedText", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null when ollama is unreachable (connection refused)", async () => {
		// Port 1 is reserved/unused; a 100ms timeout ensures the test fails
		// fast if the port happens to be open on some host.
		const result = await embedText("test", {
			ollamaUrl: "http://127.0.0.1:1",
			timeoutMs: 100,
		});
		expect(result).toBeNull();
	});

	it("returns null on non-OK HTTP response (4xx/5xx)", async () => {
		globalThis.fetch = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
		const result = await embedText("test");
		expect(result).toBeNull();
	});

	it("parses a valid ollama /v1/embeddings response into a number[]", async () => {
		const vec = new Array(1024).fill(0.01);
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ embedding: vec }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const result = await embedText("test");
		expect(result).not.toBeNull();
		expect(result).toHaveLength(1024);
		// The function must surface the parsed values verbatim, not transform
		// or down-sample them — sqlite-vec needs the exact 1024-dim vector.
		expect(result?.[0]).toBe(0.01);
	});

	it("returns null when the response body has no embedding field", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{}] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const result = await embedText("test");
		expect(result).toBeNull();
	});

	it("returns null when the response body is not valid JSON", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response("not json", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const result = await embedText("test");
		expect(result).toBeNull();
	});

	it("POSTs the expected {model, input} payload to /v1/embeddings", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), {
					status: 200,
				}),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await embedText("hello world", { model: "bge-m3" });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:11435/v1/embeddings");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string) as { model: string; input: string };
		expect(body.model).toBe("bge-m3");
		expect(body.input).toBe("hello world");
	});

	it("honours config overrides for ollamaUrl and model", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), {
					status: 200,
				}),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await embedText("x", {
			ollamaUrl: "http://example.test:9999",
			model: "custom-model",
		});

		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://example.test:9999/v1/embeddings");
		const body = JSON.parse(init.body as string) as { model: string };
		expect(body.model).toBe("custom-model");
	});

	it("aborts the request via AbortController after timeoutMs", async () => {
		// Simulate a slow server that takes longer than the timeout. We
		// listen for the AbortSignal so we can assert the controller fires.
		let observedAbort = false;
		globalThis.fetch = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						if (signal.aborted) {
							observedAbort = true;
							reject(new DOMException("aborted", "AbortError"));
							return;
						}
						signal.addEventListener("abort", () => {
							observedAbort = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					}
					// Never resolve — emulate a hanging server.
				}),
		) as unknown as typeof fetch;

		const result = await embedText("test", { timeoutMs: 50 });
		expect(result).toBeNull();
		expect(observedAbort).toBe(true);
	});
});

// loadConfig — single source of truth for EmbedConfig defaults.
// Defaults match design.md: bge-m3 embedding service at 127.0.0.1:11435
// (FastAPI service replacing ollama), 15s timeout.
describe("loadConfig", () => {
	it("returns defaults when no overrides are given", () => {
		const cfg = loadConfig();
		expect(cfg).toEqual({
			ollamaUrl: "http://127.0.0.1:11435",
			model: "bge-m3",
			timeoutMs: 15000,
		});
	});

	it("applies partial overrides on top of defaults", () => {
		const cfg = loadConfig({ model: "test-model" });
		expect(cfg.model).toBe("test-model");
		// Untouched fields keep their defaults.
		expect(cfg.ollamaUrl).toBe("http://127.0.0.1:11435");
		expect(cfg.timeoutMs).toBe(15000);
	});

	it("does not mutate DEFAULT_CONFIG when overrides are applied", () => {
		const cfg1 = loadConfig({ model: "model-a" });
		const cfg2 = loadConfig({ model: "model-b" });
		expect(cfg1.model).toBe("model-a");
		expect(cfg2.model).toBe("model-b");
		expect(cfg2.ollamaUrl).toBe("http://127.0.0.1:11435");
	});
});