import { deflateSync } from "node:zlib";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-harness.ts";

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A solid gray RGB PNG of the given size, base64 encoded. */
function createPng(width: number, height: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3, 0x80);
	row[0] = 0;
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function persistedUserContent(harness: Harness, text: string): (TextContent | ImageContent)[] {
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") continue;
		if (content[0]?.type === "text" && content[0].text.split("\n")[0] === text) return content;
	}
	throw new Error(`No user message "${text}"`);
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("AgentSession queued message images", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Regression test for #11738: queued messages skipped the image resize idle prompts get.
	it("resizes images in steering, follow-up, and streaming prompt messages", async () => {
		harness = await createHarness({ responses: [{ text: "first", delayMs: 300 }, "second", "third", "fourth"] });
		const image: ImageContent = { type: "image", data: createPng(1200, 9000), mimeType: "image/png" };

		const run = harness.session.prompt("idle");
		await waitFor(() => harness!.session.isStreaming);
		await harness.session.steer("steer", [image]);
		await harness.session.followUp("follow up", [image]);
		await harness.session.prompt("streaming prompt", { images: [image], streamingBehavior: "followUp" });
		await run;
		await waitFor(() => !harness!.session.isStreaming && harness!.faux.callCount >= 4);

		for (const text of ["steer", "follow up", "streaming prompt"]) {
			const content = persistedUserContent(harness, text);
			const images = content.filter((block): block is ImageContent => block.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0].data).not.toBe(image.data);
			expect((content[0] as TextContent).text).toContain("original 1200x9000, displayed at 267x2000");
		}
		const sentImages = harness.faux.contexts
			.flatMap((context) => context.messages)
			.flatMap((message): readonly { type: string }[] =>
				typeof message.content === "string" ? [] : message.content,
			)
			.filter((block): block is ImageContent => block.type === "image");
		expect(sentImages.length).toBeGreaterThan(0);
		expect(sentImages.some((block) => block.data === image.data)).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
