// The browser tests' DevTools driver itself (browser.ts): what a test sees once Chromium is gone. Runs only with the
// browser tests (P3_BROWSER_TESTS=1 with CHROMIUM_BIN).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BROWSER_SKIP, Browser } from "./browser.ts";

describe("the DevTools driver", { skip: BROWSER_SKIP }, () => {
	// Astra, page review round 1: a call after the close waited out its whole 60 s timeout.
	it("fails a call made after the socket closed at once", async () => {
		const browser = await Browser.start();
		await browser.close();
		const started = performance.now();
		await assert.rejects(browser.evaluate("1"), /socket closed/);
		assert.ok(performance.now() - started < 1_000);
	});
});
