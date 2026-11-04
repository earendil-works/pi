import { describe, expect, it } from "vitest";
import { type LlmContent, limitMcpContent, MCP_OUTPUT_MAX_BYTES } from "../src/index.ts";

const image: LlmContent = { type: "image", data: "AAAA", mimeType: "image/png" };

function textOf(content: LlmContent[]): string {
	const [first] = content;
	if (first?.type !== "text") throw new Error("expected a text block first");
	return first.text;
}

describe("limitMcpContent", () => {
	it("returns content within the limit as it is, without saving", async () => {
		const content: LlmContent[] = [{ type: "text", text: "x".repeat(MCP_OUTPUT_MAX_BYTES) }, image];
		let saves = 0;
		const limited = await limitMcpContent(content, async () => {
			saves++;
			return "/tmp/full.txt";
		});
		expect(limited).toEqual({ content });
		expect(limited.content).toBe(content);
		expect(saves).toBe(0);
	});

	it("cuts the middle of longer text, saves the full text and keeps images", async () => {
		const full = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
		const saved: [string | Uint8Array, string][] = [];
		const split = full.indexOf("\n", 100);
		const limited = await limitMcpContent(
			[{ type: "text", text: full.slice(0, split) }, image, { type: "text", text: full.slice(split + 1) }],
			async (data, extension) => {
				saved.push([data, extension]);
				return "/tmp/full.txt";
			},
		);
		// Text blocks are joined with newlines before the limit applies.
		expect(saved).toEqual([[full, ".txt"]]);
		expect(limited.fullOutputPath).toBe("/tmp/full.txt");
		expect(limited.content).toHaveLength(2);
		expect(limited.content[1]).toEqual(image);
		const text = textOf(limited.content);
		expect(text).toMatch(
			new RegExp(
				`^Warning: truncated output \\(original token count: ${Math.ceil(full.length / 4)}\\)\nTotal output lines: 3000\n\nline 1\nline 2\n`,
			),
		);
		expect(text).toMatch(/…\d+ chars truncated…/);
		expect(text.endsWith("line 3000\n\n[Full output: /tmp/full.txt (read it with offset/limit)]")).toBe(true);
		expect(Buffer.byteLength(text)).toBeLessThan(MCP_OUTPUT_MAX_BYTES + 1024);
	});

	it("reports a failed save, and names no file without a saver", async () => {
		const content: LlmContent[] = [{ type: "text", text: "y".repeat(MCP_OUTPUT_MAX_BYTES + 1) }];
		const failed = await limitMcpContent(content, async () => {
			throw new Error("disk full");
		});
		expect(failed.fullOutputPath).toBeUndefined();
		expect(textOf(failed.content).endsWith("\n\n[Could not save the full output: disk full]")).toBe(true);

		const unsaved = await limitMcpContent(content);
		expect(unsaved.fullOutputPath).toBeUndefined();
		expect(textOf(unsaved.content)).toMatch(/^Warning: truncated output .*…\d+ chars truncated…y+$/s);
	});

	it("cuts multi-byte text only at character boundaries", async () => {
		// After the one-byte prefix, characters start at odd bytes, and both cuts (byte 10240 and byte
		// 40004 - 10240) are even: each lands inside a two-byte character.
		const text = `a${"é".repeat(20_000)}end`;
		const limited = textOf((await limitMcpContent([{ type: "text", text }])).content);
		expect(limited).not.toContain("\uFFFD");
		expect(limited.endsWith("end")).toBe(true);
		const marker = /…(\d+) chars truncated…/.exec(limited);
		if (!marker) throw new Error("expected the truncation marker");
		const [head, tail] = limited.slice(limited.indexOf("\n\n") + 2).split(marker[0]);
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES / 2);
		expect(Array.from(head).length + Array.from(tail).length + Number(marker[1])).toBe(Array.from(text).length);
	});
});
