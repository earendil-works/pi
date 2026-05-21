import { describe, expect, it } from "vitest";
import { getAppUserAgent } from "../src/utils/app-user-agent.ts";

describe("getAppUserAgent", () => {
	it("formats the user agent expected by lyla.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAppUserAgent("1.2.3");

		expect(userAgent).toBe(`lyla/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^lyla\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
