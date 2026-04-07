import { describe, expect, it } from "vitest";

import { createXmlTagExtractor } from "../src/utils/xml-tag-extractor.js";

function extract(tags: string[], deltas: string[]): Record<string, string> {
	const extractor = createXmlTagExtractor(tags);
	for (const delta of deltas) extractor.push(delta);
	return extractor.end();
}

describe("xml tag extractor", () => {
	it("extracts title and preview from a single chunk", () => {
		expect(extract(["title", "preview"], ["<title>Hello</title>\n<preview>World</preview>"])).toEqual({
			title: "Hello",
			preview: "World",
		});
	});

	it("extracts across split chunks", () => {
		expect(extract(["title", "preview"], ["<title>Hel", "lo</title><preview>W", "orld</preview>"])).toEqual({
			title: "Hello",
			preview: "World",
		});
	});

	it("extracts across split closing tags", () => {
		expect(extract(["title", "preview"], ["<title>Hi</ti", "tle><preview>Yo</prev", "iew>"])).toEqual({
			title: "Hi",
			preview: "Yo",
		});
	});

	it("ignores text outside tracked tags", () => {
		expect(
			extract(["title", "preview"], ["noise <title>Clean</title> more <preview>Nice preview</preview> tail"]),
		).toEqual({
			title: "Clean",
			preview: "Nice preview",
		});
	});

	it("supports tag attributes and mixed case", () => {
		expect(extract(["title", "preview"], ['<TITLE lang="en">Hello</TITLE><Preview data-x="y">Hi</Preview>'])).toEqual(
			{
				title: "Hello",
				preview: "Hi",
			},
		);
	});

	it("returns empty string for missing or empty tags", () => {
		expect(extract(["title", "preview"], ["<title>X</title><preview></preview>"])).toEqual({
			title: "X",
			preview: "",
		});
		expect(extract(["title", "preview"], ["<title>X</title>"])).toEqual({
			title: "X",
			preview: "",
		});
	});

	it("supports a single analysis tag", () => {
		expect(extract(["analysis"], ["prefix<analysis>Result here</analysis>suffix"])).toEqual({
			analysis: "Result here",
		});
	});
});
