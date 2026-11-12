import { EventEmitter } from "node:events";
import { type Browser, chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWeb } from "../src/core/readers/web.ts";

vi.mock("../src/core/readers/pdf.ts", () => ({ readPdf: vi.fn() }));

const marker = "about:blank#pi-owned-test-tab";
const url = "https://example.com/article";
const request = {
	path: url,
	strategy: "browser" as const,
	pdfiumWasmPath: "unused",
	browserConnection: { endpoint: "ws://127.0.0.1:9222/devtools/browser/fixture", pageUrl: marker },
};
const html =
	"<html><head><title>Reference</title></head><body><main><h1>Reference guide</h1><p>This is the requested document with useful reference content that should remain in the extracted browser snapshot.</p></main></body></html>";

class FakePage extends EventEmitter {
	currentUrl = marker;
	frame = { url: () => this.currentUrl };
	url = () => this.currentUrl;
	mainFrame = () => this.frame;
	goto = vi.fn(async (_url: string, _options: unknown) => {
		this.currentUrl = url;
		return { ok: (): boolean => true, status: (): number => 200 };
	});
	waitForLoadState = vi.fn(async (_state: string, _options: unknown) => {});
	content = vi.fn(async () => html);
}

let page: FakePage;
const close = vi.fn(async () => {});
beforeEach(() => {
	page = new FakePage();
	close.mockClear();
	vi.spyOn(chromium, "connectOverCDP").mockResolvedValue({
		contexts: () => [{ pages: () => [page] }],
		close,
	} as unknown as Browser);
});
afterEach(() => vi.restoreAllMocks());

describe("leased browser extraction", () => {
	it("attaches without resetting browser defaults and disconnects without closing the shared context", async () => {
		const result = await readWeb(request);
		expect(result.status).toBe("ok");
		expect(result.text).toContain("Reference guide");
		expect(chromium.connectOverCDP).toHaveBeenCalledWith(request.browserConnection.endpoint, {
			timeout: 15_000,
			noDefaults: true,
		});
		expect(close).toHaveBeenCalledOnce();
		expect(page.listenerCount("framenavigated")).toBe(0);
	});

	it("waits for a startup blank-tab reload before retrying its cancelled navigation once", async () => {
		page.goto.mockImplementationOnce(async () => {
			queueMicrotask(() => page.emit("framenavigated", page.frame));
			throw new Error("page.goto: net::ERR_ABORTED");
		});
		expect((await readWeb(request)).status).toBe("ok");
		expect(page.goto).toHaveBeenCalledTimes(2);
		expect(page.waitForLoadState).toHaveBeenCalledWith("load", { timeout: 5000 });
		expect(page.listenerCount("framenavigated")).toBe(0);
	});

	it("does not loop when a navigation is cancelled again", async () => {
		page.goto.mockImplementation(async () => {
			page.emit("framenavigated", page.frame);
			throw new Error("page.goto: net::ERR_ABORTED");
		});
		await expect(readWeb(request)).rejects.toThrow("ERR_ABORTED");
		expect(page.goto).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledOnce();
	});

	it("does not retry a cancellation after the tab has navigated away from its owned blank marker", async () => {
		page.goto.mockImplementation(async () => {
			page.currentUrl = "https://example.com/other";
			throw new Error("page.goto: net::ERR_ABORTED");
		});
		await expect(readWeb(request)).rejects.toThrow("ERR_ABORTED");
		expect(page.goto).toHaveBeenCalledOnce();
	});

	it("does not mistake an HTTP error for a startup navigation race", async () => {
		page.goto.mockResolvedValueOnce({ ok: () => false, status: () => 403 });
		await expect(readWeb(request)).rejects.toThrow("Browser HTTP 403");
		expect(page.goto).toHaveBeenCalledOnce();
	});

	it("requires an owned project-tab lease instead of silently starting another browser", async () => {
		await expect(readWeb({ ...request, browserConnection: undefined })).rejects.toThrow("project browser lease");
		expect(chromium.connectOverCDP).not.toHaveBeenCalled();
	});
});
