import { describe, expect, it } from "vitest";
import { type ContentBlock, toLlmContent } from "../src/index.ts";

describe("toLlmContent", () => {
	it("passes text and images through and replaces other blocks with text", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "hello", annotations: { priority: 1 } },
			{ type: "image", data: "aW1n", mimeType: "image/png", _meta: { x: 1 } },
			{ type: "audio", data: "YXVk", mimeType: "audio/wav" },
			{ type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
			{ type: "resource", resource: { uri: "file:///b.txt", text: "inline" } },
			{ type: "resource", resource: { uri: "file:///c.png", mimeType: "image/png", blob: "Yw==" } },
			{ type: "resource", resource: { uri: "file:///d.bin", blob: "ZA==" } },
		];
		expect(toLlmContent({ content: blocks })).toEqual([
			{ type: "text", text: "hello" },
			{ type: "image", data: "aW1n", mimeType: "image/png" },
			{ type: "text", text: "[audio audio/wav omitted]" },
			{ type: "text", text: "a.txt: file:///a.txt" },
			{ type: "text", text: "inline" },
			{ type: "image", data: "Yw==", mimeType: "image/png" },
			{ type: "text", text: "[binary resource file:///d.bin (unknown type) omitted]" },
		]);
	});

	it("falls back to the structured content as JSON when there are no blocks", () => {
		// #10416: structured content may be any JSON value.
		expect(toLlmContent({ content: [], structuredContent: [1, 2] })).toEqual([
			{ type: "text", text: "[\n  1,\n  2\n]" },
		]);
		expect(toLlmContent({ content: [], structuredContent: null })).toEqual([{ type: "text", text: "null" }]);
		expect(toLlmContent({ content: [], structuredContent: { n: 1 } })).toEqual([
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		expect(toLlmContent({ content: [{ type: "text", text: "n=1" }], structuredContent: { n: 1 } })).toEqual([
			{ type: "text", text: "n=1" },
		]);
	});
});
