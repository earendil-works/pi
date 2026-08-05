import { crc32, deflateSync } from "node:zlib";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function pngChunk(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(body.length, 0);
	header.write(type, 4, "ascii");
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
	return Buffer.concat([header, body, checksum]);
}

/** Build an 8-bit grayscale PNG of arbitrary dimensions without pulling in an encoder. */
function createPng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // color type: grayscale
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row++) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function readPngDimensions(base64Data: string): { width: number; height: number } {
	const buffer = Buffer.from(base64Data, "base64");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const OVERSIZED_PNG_BASE64 = createPng(2400, 4800).toString("base64");

/** Stands in for extension, MCP bridge, or screenshot tools that return images they produced. */
const screenshotTool: AgentTool = {
	name: "screenshot",
	label: "Screenshot",
	description: "Return an oversized screenshot",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [
			{ type: "text", text: "captured" },
			{ type: "image", data: OVERSIZED_PNG_BASE64, mimeType: "image/png" },
		],
		details: {},
	}),
};

function getToolResultImages(harness: Harness): ImageContent[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.flatMap((message) => message.content)
		.filter((block): block is ImageContent => block.type === "image");
}

describe("AgentSession tool result images", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resizes oversized tool result images before they enter history", async () => {
		const harness = await createHarness({ tools: [screenshotTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("take a screenshot");

		const images = getToolResultImages(harness);
		expect(images).toHaveLength(1);
		const { width, height } = readPngDimensions(images[0].data);
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
	});

	it("honors images.autoResize being disabled", async () => {
		const harness = await createHarness({
			tools: [screenshotTool],
			settings: { images: { autoResize: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("take a screenshot");

		const images = getToolResultImages(harness);
		expect(images).toHaveLength(1);
		expect(images[0].data).toBe(OVERSIZED_PNG_BASE64);
	});
});
