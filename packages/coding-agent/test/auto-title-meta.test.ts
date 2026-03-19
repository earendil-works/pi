import { describe, expect, it } from "vitest";

import { parseThreadListingMetaXml, stripUserMessageTimePrefix } from "../src/utils/auto-title.js";

describe("auto-title: thread listing meta", () => {
	it("parses <title> and <preview> from XML", () => {
		const parsed = parseThreadListingMetaXml("<title>Hello</title>\n<preview>World</preview>");
		expect(parsed).toEqual({ title: "Hello", preview: "World" });
	});

	it("returns null when missing preview", () => {
		expect(parseThreadListingMetaXml("<title>Hello</title>")).toBeNull();
	});

	it("strips user_message_time prefix", () => {
		const input = "<user_message_time>Monday, Feb 16</user_message_time>\n\nHow do I do X?";
		expect(stripUserMessageTimePrefix(input)).toBe("How do I do X?");
	});

	it("strips user_message_time prefix when timestamp and prompt are split across text blocks", () => {
		const input = "<user_message_time>Monday, Feb 16</user_message_time>How do I do X?";
		expect(stripUserMessageTimePrefix(input)).toBe("How do I do X?");
	});
});
