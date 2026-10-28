import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/image-resize.js", () => ({
	resizeImage: vi.fn(),
	formatDimensionNote: vi.fn(() => undefined),
}));

import { processFileArguments } from "../src/cli/file-processor.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { resizeImage } from "../src/utils/image-resize.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("image resize callers", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `image-resize-callers-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		vi.mocked(resizeImage).mockReset();
		vi.mocked(resizeImage).mockResolvedValue(null);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read tool returns text-only output when auto-resize cannot produce a safe image", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const tool = createReadTool(testDir);
		const result = await tool.execute("test-read-image", { path: imagePath });

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("Image omitted");
	});

	it("file processor omits image attachments when auto-resize cannot produce a safe image", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("Image omitted");
	});

	it("passes the current model resize profile to the read tool", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const resize = { maxWidth: 1234, maxHeight: 1000, maxBytes: 500000, jpegQuality: 70 };
		const model: Model<Api> = {
			id: "vision-model",
			name: "Vision model",
			api: "test",
			provider: "test",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text", "image"],
			inputLimits: { images: { resize } },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const ctx = { cwd: testDir, model } as unknown as ExtensionToolContext;

		await createReadToolDefinition(testDir).execute(
			"test-read-model-profile",
			{ path: imagePath },
			undefined,
			undefined,
			ctx,
		);

		expect(resizeImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", resize);
	});

	it("can defer resizing file attachments until prompt dispatch", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await processFileArguments([imagePath], { autoResizeImages: false });

		expect(result.images).toHaveLength(1);
		expect(resizeImage).not.toHaveBeenCalled();
	});
});
