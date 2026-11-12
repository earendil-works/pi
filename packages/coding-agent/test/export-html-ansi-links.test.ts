import { describe, expect, it } from "vitest";
import { ansiToHtml } from "../src/core/export-html/ansi-to-html.ts";

const link = (url: string, text: string, end = "\x1b\\") => `\x1b]8;;${url}${end}${text}\x1b]8;;${end}`;

describe("export HTML ANSI hyperlinks", () => {
	it("converts OSC 8 hyperlinks to anchors", () => {
		expect(ansiToHtml(`see ${link("https://example.com/a?b=1&c=2", "\x1b[4mdocs\x1b[24m")}.`)).toBe(
			'see <a href="https://example.com/a?b=1&amp;c=2"><span style="text-decoration:underline">docs</span></a>.',
		);
		expect(ansiToHtml(link("mailto:me@example.com", "mail", "\x07"))).toBe(
			'<a href="mailto:me@example.com">mail</a>',
		);
	});

	it("keeps styled text nested inside the anchor and closes an unterminated link", () => {
		expect(ansiToHtml(`\x1b[31mred \x1b]8;;https://example.com\x1b\\link`)).toBe(
			'<span style="color:#800000">red </span><a href="https://example.com"><span style="color:#800000">link</span></a>',
		);
	});

	it("drops links with unsafe schemes and other escape sequences", () => {
		expect(ansiToHtml(link("javascript:alert(1)", "x"))).toBe("x");
		expect(ansiToHtml(link("java\x01script:alert(1)", "x"))).toBe("x");
		expect(ansiToHtml("\x1b]0;title\x07a\x1b[2Kb\x1b]133;A\x1b\\c\x1b_pi:c\x07d\x1be")).toBe("abcde");
	});
});
