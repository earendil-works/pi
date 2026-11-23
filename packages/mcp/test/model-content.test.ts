import { describe, expect, it } from "vitest";
import { type ContentBlock, toMcpModelContent } from "../src/index.ts";

const link: ContentBlock = {
	type: "resource_link",
	uri: "docs://guide",
	name: "guide",
	title: "The Guide",
	mimeType: "text/markdown",
	size: 2048,
	description: "How to use it",
};
const pdf: ContentBlock = {
	type: "resource",
	resource: { uri: "file:///r/report.pdf", mimeType: "application/pdf", blob: "JVBERg==" },
};

describe("toMcpModelContent", () => {
	it("names the read tool in resource links when there is one", async () => {
		expect(await toMcpModelContent("docs", { content: [link] }, { readResourceTool: "read_mcp_resource" })).toEqual([
			{
				type: "text",
				text: '[Resource docs://guide "The Guide" (text/markdown, 2.0KB): How to use it. Read it with read_mcp_resource (server "docs")]',
			},
		]);
		expect(
			await toMcpModelContent("docs", { content: [{ type: "resource_link", uri: "file:///a", name: "a" }] }),
		).toEqual([{ type: "text", text: '[Resource file:///a "a"]' }]);
	});

	it("saves binary resources, shows text blobs as text and keeps images", async () => {
		const saved: [string | Uint8Array, string][] = [];
		const saveOutput = async (data: string | Uint8Array, extension: string) => {
			saved.push([data, extension]);
			return `/tmp/saved${extension}`;
		};
		const json = Buffer.from('{"a":1}').toString("base64");
		const content: ContentBlock[] = [
			pdf,
			{
				type: "resource",
				resource: { uri: "docs://data", mimeType: "application/json; charset=utf-8", blob: json },
			},
			{ type: "resource", resource: { uri: "docs://logo", mimeType: "image/png", blob: "AAAA" } },
			{ type: "resource", resource: { uri: "docs://raw", blob: "AAAA" } },
		];
		expect(await toMcpModelContent("docs", { content }, { saveOutput })).toEqual([
			{ type: "text", text: "[Binary resource file:///r/report.pdf (application/pdf, 4B) saved to /tmp/saved.pdf]" },
			{ type: "text", text: '{"a":1}' },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "[Binary resource docs://raw (unknown type, 3B) saved to /tmp/saved.bin]" },
		]);
		expect(saved).toEqual([
			[Buffer.from("%PDF"), ".pdf"],
			[Buffer.from("AAAA", "base64"), ".bin"],
		]);
	});

	it("leaves binary resources out without a saver, and says why when saving fails", async () => {
		expect(await toMcpModelContent("docs", { content: [pdf] })).toEqual([
			{ type: "text", text: "[binary resource file:///r/report.pdf (application/pdf) omitted]" },
		]);
		const failing = async () => {
			throw new Error("disk full");
		};
		expect(await toMcpModelContent("docs", { content: [pdf] }, { saveOutput: failing })).toEqual([
			{
				type: "text",
				text: "[Binary resource file:///r/report.pdf (application/pdf, 4B) could not be saved: disk full]",
			},
		]);
	});

	it("shows structured content as JSON when there are no content blocks", async () => {
		expect(await toMcpModelContent("docs", { content: [], structuredContent: [{ id: 1 }] })).toEqual([
			{ type: "text", text: '[\n  {\n    "id": 1\n  }\n]' },
		]);
	});
});
