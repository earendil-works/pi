import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../src/core/readers/pdf.ts";
import { readWeb } from "../src/core/readers/web.ts";

vi.mock("../src/core/readers/pdf.ts", () => ({ readPdf: vi.fn() }));

const url = "https://example.com/article";
const request = { path: url, pdfiumWasmPath: "unused" };
const article =
	'<html><head><title>Reference</title></head><body><main><h1>Reference guide</h1><p>This is the requested document, with useful reference information and a <a href="/details">details link</a>.</p><pre><code>const answer = 42;</code></pre></main></body></html>';
const fetchMock = vi.fn<typeof fetch>();

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html", ...headers } });
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "");
	vi.spyOn(chromium, "connectOverCDP").mockRejectedValue(new Error("Unexpected automatic browser use"));
});

afterEach(() => {
	expect(chromium.connectOverCDP).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("web read retries and bot protection", () => {
	it("keeps ordinary reads to one request with Markdown negotiation", async () => {
		fetchMock.mockResolvedValueOnce(html(article));
		const result = await readWeb(request);
		expect(result.status).toBe("ok");
		expect(result.text).toContain("const answer = 42;");
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
			redirect: "manual",
			signal: expect.any(AbortSignal),
			headers: {
				Accept: expect.stringContaining("text/markdown"),
				"User-Agent": "pi-read/1.0",
			},
		});
	});

	it("cancels a 403 body and retries once with a browser User-Agent and the same deadline", async () => {
		const refused = html("Forbidden", 403);
		const cancel = vi.spyOn(refused.body!, "cancel");
		fetchMock.mockResolvedValueOnce(refused).mockResolvedValueOnce(html(article));
		expect((await readWeb(request)).status).toBe("ok");
		expect(cancel).toHaveBeenCalledOnce();
		const [initial, retry] = fetchMock.mock.calls.map((call) => call[1]!);
		expect(retry.headers).toEqual({ ...initial.headers, "User-Agent": expect.stringContaining("Chrome/") });
		expect(retry.signal).toBe(initial.signal);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reports an exhausted 403 retry and detected protection without claiming access", async () => {
		fetchMock.mockResolvedValue(html("Challenge", 403, { "cf-mitigated": "challenge" }));
		await expect(readWeb(request)).rejects.toThrow(
			/HTTP 403.*retried HTTP 403 once.*Bot protection detected \(Cloudflare\).*strategy:"browser".*does not grant access/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([401, 404, 500, 503])("does not rotate User-Agents or retry HTTP %s", async (status) => {
		fetchMock.mockResolvedValue(html("Server error", status));
		await expect(readWeb(request)).rejects.toThrow(`HTTP ${status}`);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("honors Retry-After seconds and retries 429 only once with the same identity", async () => {
		fetchMock.mockResolvedValue(html("Slow down", 429, { "Retry-After": "0" }));
		await expect(readWeb(request)).rejects.toThrow(
			/HTTP 429.*retried HTTP 429 once after 0 ms without changing User-Agent/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
	});

	it.each([
		["2", 2000],
		["Wed, 01 Jan 2020 00:00:00 GMT", 0],
	] as const)("honors Retry-After %s as %s ms", async (value, milliseconds) => {
		fetchMock.mockImplementation(async () => html("Slow down", 429, { "Retry-After": value }));
		await expect(readWeb(request)).rejects.toThrow(`retried HTTP 429 once after ${milliseconds} ms`);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
	});

	it("honors a future HTTP-date before retrying", async () => {
		const now = Date.parse("Wed, 01 Jan 2025 00:00:00 GMT");
		vi.spyOn(Date, "now").mockReturnValue(now);
		fetchMock
			.mockResolvedValueOnce(html("Slow down", 429, { "Retry-After": "Wed, 01 Jan 2025 00:00:01 GMT" }))
			.mockResolvedValueOnce(html(article));
		const start = performance.now();
		expect((await readWeb(request)).status).toBe("ok");
		expect(performance.now() - start).toBeGreaterThanOrEqual(900);
		expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
	});

	it.each([undefined, "invalid", "-1"])("uses a bounded default delay for Retry-After %s", async (value) => {
		fetchMock.mockResolvedValue(html("Slow down", 429, value === undefined ? {} : { "Retry-After": value }));
		await expect(readWeb(request)).rejects.toThrow("retried HTTP 429 once after 1000 ms");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["60", "9999999999999999999999999999999999999999999999"])(
		"does not retry earlier than a Retry-After value beyond the retry budget (%s)",
		async (value) => {
			fetchMock.mockResolvedValue(html("Slow down", 429, { "Retry-After": value }));
			await expect(readWeb(request)).rejects.toThrow(/HTTP 429.*retry skipped.*10-second retry budget/);
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it("does not wait past the remaining shared deadline", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(19_000);
		fetchMock.mockResolvedValue(html("Slow down", 429, { "Retry-After": "2" }));
		await expect(readWeb(request)).rejects.toThrow("retry skipped");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("allows the shared deadline to interrupt Retry-After without another fetch", async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		fetchMock.mockResolvedValue(html("Slow down", 429, { "Retry-After": "10" }));
		const pending = readWeb(request);
		const rejected = expect(pending).rejects.toThrow(/abort/i);
		await delay(10);
		controller.abort();
		await rejected;
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("keeps 429 and 403 retry counts independent without rotating on a second 429", async () => {
		fetchMock
			.mockResolvedValueOnce(html("Slow down", 429, { "Retry-After": "0" }))
			.mockResolvedValueOnce(html("Forbidden", 403))
			.mockResolvedValueOnce(html("Slow down", 429, { "Retry-After": "0" }));
		await expect(readWeb(request)).rejects.toThrow(/HTTP 429.*retried HTTP 429 once.*retried HTTP 403 once/);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const options = fetchMock.mock.calls.map((call) => call[1]!);
		expect(options[0]).toEqual(options[1]);
		expect(options[2].headers).toMatchObject({ "User-Agent": expect.stringContaining("Chrome/") });
	});

	it("retains the browser identity when a 403 retry is subsequently rate-limited", async () => {
		fetchMock
			.mockResolvedValueOnce(html("Forbidden", 403))
			.mockResolvedValueOnce(html("Slow down", 429, { "Retry-After": "0" }))
			.mockResolvedValueOnce(html(article));
		expect((await readWeb(request)).status).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2][1]).toEqual(fetchMock.mock.calls[1][1]);
	});

	it("does not reset retries or the deadline on redirects", async () => {
		fetchMock
			.mockResolvedValueOnce(html("Forbidden", 403))
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/redirected" } }))
			.mockResolvedValueOnce(html("Forbidden", 403));
		await expect(readWeb(request)).rejects.toThrow("https://example.com/redirected");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2][1]).toEqual(fetchMock.mock.calls[1][1]);
	});

	it("keeps redirects bounded and rejects non-HTTP and credential-bearing targets", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "/loop" } }));
		await expect(readWeb(request)).rejects.toThrow("redirect limit exceeded (5)");
		expect(fetchMock).toHaveBeenCalledTimes(6);
		for (const target of ["file:///etc/passwd", "https://user:password@example.com/private"]) {
			fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { Location: target } }));
			await expect(readWeb(request)).rejects.toThrow(/HTTP or HTTPS|Credentials in URLs/);
			expect(fetchMock).toHaveBeenCalledOnce();
		}
	});

	it("uses the successful retry's original bytes for PDFs without another fetch", async () => {
		const bytes = Buffer.from("%PDF-fixture");
		vi.mocked(readPdf).mockResolvedValueOnce({
			status: "ok",
			text: "PDF text",
			images: [],
			source: { kind: "pdf", path: url, pageCount: 1, pages: [1] },
		});
		fetchMock
			.mockResolvedValueOnce(html("Forbidden", 403))
			.mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "application/pdf" } }));
		const result = await readWeb(request);
		expect(result.source).toMatchObject({ kind: "pdf", finalUrl: url });
		expect(readPdf).toHaveBeenLastCalledWith(request, bytes);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("bounds error-body diagnostics and cancels a nonterminating response", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Buffer.from(`<html><body>${"x".repeat(80 * 1024)}`));
			},
			cancel,
		});
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response(body, { status: 403, headers: { "Content-Type": "text/html" } }));
		await expect(readWeb(request)).rejects.toThrow("HTTP 403");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("preserves the HTTP status when reading an error body fails", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("Broken stream"));
					},
				}),
				{ status: 503, headers: { "Content-Type": "text/html" } },
			),
		);
		await expect(readWeb(request)).rejects.toThrow("HTTP 503");
	});

	it("rejects a Cloudflare challenge header even with HTTP 200 or non-HTML content", async () => {
		fetchMock.mockResolvedValue(
			new Response("not the requested page", {
				status: 200,
				headers: { "cf-mitigated": "challenge", "Content-Type": "text/plain" },
			}),
		);
		await expect(readWeb(request)).rejects.toThrow(
			/HTTP 200.*Bot protection detected \(Cloudflare\).*strategy:"browser"/,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		"<h1>Verify you are human</h1><p>Complete the security check to continue.</p>",
		'<form><input name="js_challenge"></form>',
		'<form id="challenge-form">Checking your browser</form>',
		"<h1>Access denied</h1><p>Your request has been blocked.</p>",
	])("marks a 200 challenge as unreadable without launching a browser: %s", async (body) => {
		fetchMock.mockResolvedValue(html(`<html><head><title>Security</title></head><body>${body}</body></html>`));
		const result = await readWeb(request);
		expect(result.status).toBe("unreadable");
		expect(result.source).toMatchObject({ kind: "web", strategy: "blocked", statusCode: 200 });
		expect(result.text).toContain("this is not the requested document");
		expect(result.text).toContain("No automatic browser fallback");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("identifies live challenge markup in an HTTP error body", async () => {
		fetchMock.mockImplementation(async () => html('<html><body><input name="js_challenge"></body></html>', 403));
		await expect(readWeb(request)).rejects.toThrow("Bot protection detected (JavaScript challenge)");
	});

	it("does not mistake code, scripts, templates, or ordinary mentions for a challenge", async () => {
		const body = article.replace(
			"</main>",
			'<p>Sites may ask you to verify you are human.</p><pre><code>&lt;input name="js_challenge"&gt;</code></pre><script>const example = \'<input name="js_challenge">\';</script><template><input name="js_challenge"></template></main>',
		);
		fetchMock.mockResolvedValue(html(body));
		const result = await readWeb(request);
		expect(result.status).toBe("ok");
		expect(result.text).toContain("const answer = 42;");
		expect(result.text).toContain('<input name="js_challenge">');
	});

	it("does not classify a substantial article by its challenge-like title", async () => {
		fetchMock.mockResolvedValue(
			html(
				`<html><head><title>Verify you are human</title></head><body><main><h1>Verify you are human</h1><p>${"An article explaining security systems. ".repeat(100)}</p></main></body></html>`,
			),
		);
		expect((await readWeb(request)).status).toBe("ok");
	});

	it("keeps negotiated Markdown and plain text unchanged even when they discuss challenges", async () => {
		for (const contentType of ["text/markdown", "text/plain"]) {
			const text = "Verify you are human\n\nAn explanation of bot protection.";
			fetchMock.mockReset().mockResolvedValue(new Response(text, { headers: { "Content-Type": contentType } }));
			const result = await readWeb(request);
			expect(result.status).toBe("ok");
			expect(result.text).toContain(text);
			expect(fetchMock).toHaveBeenCalledOnce();
		}
	});
});
