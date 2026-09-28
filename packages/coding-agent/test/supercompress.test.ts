import { describe, expect, it } from "vitest";
import {
	compressContext,
	fitsPreview,
	latestUserText,
	previewFromSpill,
	SUPERCOMPRESS_URL,
} from "../src/core/tools/supercompress.ts";

describe("shell output preview", () => {
	it("uses the latest user message", () => {
		expect(
			latestUserText([
				{ role: "user", content: "first" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: [{ type: "text", text: "find the disk full error" }] },
			]),
		).toBe("find the disk full error");
	});

	it("keeps a shorter preview that fits the tail cap", async () => {
		const full = `${"noise\n".repeat(200)}error: disk full\n`;
		let called = 0;
		const preview = await previewFromSpill({
			spillPath: "/tmp/pi-bash-output.txt",
			query: "find the disk full error",
			maxBytes: 50 * 1024,
			maxLines: 2000,
			apiKey: "test-key",
			statImpl: async () => ({ size: full.length }),
			readFileImpl: async () => full,
			fetchImpl: async (url, init) => {
				called += 1;
				expect(url).toBe(SUPERCOMPRESS_URL);
				expect(new Headers(init?.headers).get("X-API-Key")).toBe("test-key");
				const body = JSON.parse(String(init?.body));
				expect(body.query).toBe("find the disk full error");
				expect(body.context).toContain("error: disk full");
				return new Response(JSON.stringify({ compressed_text: "error: disk full" }), { status: 200 });
			},
		});
		expect(called).toBe(1);
		expect(preview).toBe("error: disk full\n\n[Full output: /tmp/pi-bash-output.txt]");
	});

	it("keeps the tail when the call fails or the preview does not fit", async () => {
		const full = "x".repeat(1000);
		const failed = await previewFromSpill({
			spillPath: "/tmp/out.txt",
			query: "task",
			maxBytes: 100,
			maxLines: 10,
			apiKey: "test-key",
			statImpl: async () => ({ size: full.length }),
			readFileImpl: async () => full,
			fetchImpl: async () => new Response("no", { status: 503 }),
		});
		expect(failed).toBeNull();

		const tooWide = await previewFromSpill({
			spillPath: "/tmp/out.txt",
			query: "task",
			maxBytes: 20,
			maxLines: 10,
			apiKey: "test-key",
			statImpl: async () => ({ size: full.length }),
			readFileImpl: async () => full,
			fetchImpl: async () => new Response(JSON.stringify({ compressed_text: "y".repeat(40) }), { status: 200 }),
		});
		expect(tooWide).toBeNull();
		expect(fitsPreview("y".repeat(40), 20, 10)).toBe(false);
	});

	it("does not send a spill larger than the api context limit", async () => {
		const preview = await previewFromSpill({
			spillPath: "/tmp/out.txt",
			query: "task",
			maxBytes: 100,
			maxLines: 10,
			apiKey: "test-key",
			statImpl: async () => ({ size: 120_001 }),
			readFileImpl: async () => {
				throw new Error("should not read");
			},
			fetchImpl: async () => {
				throw new Error("should not fetch");
			},
		});
		expect(preview).toBeNull();
	});

	it("rejects a result that is not shorter", async () => {
		const context = "same";
		const text = await compressContext({
			context,
			query: "task",
			apiKey: "test-key",
			fetchImpl: async () => new Response(JSON.stringify({ compressed_text: context }), { status: 200 }),
		});
		expect(text).toBeNull();
	});
});
