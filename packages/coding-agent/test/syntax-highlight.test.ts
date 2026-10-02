import { Markdown, resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMarkdownTheme, highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	highlight,
	loadAllHighlightLanguages,
	renderHighlightedHtml,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

const eagerLanguages = [
	"python",
	"java",
	"go",
	"javascript",
	"cpp",
	"typescript",
	"php",
	"ruby",
	"c",
	"csharp",
	"nix",
	"bash",
	"rust",
	"scala",
	"kotlin",
	"swift",
	"dart",
	"groovy",
	"perl",
	"lua",
];
const eagerLanguagesLoadedAtStartup = eagerLanguages.every(supportsLanguage);
const uncommonLanguageLoadedAtStartup = supportsLanguage("ada");

describe("syntax highlight renderer", () => {
	it("loads the twenty most common languages at startup and defers the rest", async () => {
		expect(eagerLanguagesLoadedAtStartup).toBe(true);
		expect(uncommonLanguageLoadedAtStartup).toBe(false);
		await loadAllHighlightLanguages();
		expect(supportsLanguage("ada")).toBe(true);
	});

	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	// Regression for #10143: every style must be self-contained on each line, regardless of scope.
	it.each([
		["string", "\x1b[31m", "\x1b[39m"],
		["comment", "\x1b[38;5;240m", "\x1b[39m"],
		["custom", "\x1b[38;2;10;20;30m", "\x1b[39m"],
		["emphasis", "\x1b[3m", "\x1b[23m"],
		["strong", "\x1b[1m", "\x1b[22m"],
		["link", "\x1b[4m", "\x1b[24m"],
		["custom-background", "\x1b[44m", "\x1b[49m"],
	])("formats each line of a multiline %s span independently", (scope, open, close) => {
		const rendered = renderHighlightedHtml(`before<span class="hljs-${scope}">first\nsecond\nthird</span>after`, {
			[scope]: (text) => `${open}${text}${close}`,
		});
		expect(rendered.split("\n")).toEqual([
			`before${open}first${close}`,
			`${open}second${close}`,
			`${open}third${close}after`,
		]);
	});

	// Regression for #10143: preserve line endings and empty lines without styling separators.
	it.each(["\n", "\r\n", "\r"])("keeps %j line endings outside formatting", (newline) => {
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">${newline}first${newline}${newline}second${newline}</span>`,
			{ string: (text) => `[string:${text}]` },
		);
		expect(rendered).toBe(`${newline}[string:first]${newline}${newline}[string:second]${newline}`);
	});

	// Regression for #10143: a span containing only line breaks must not add style-only lines.
	it.each(["", "\n", "\n\n", "\r\n", "\r"])("preserves empty span content %j", (text) => {
		expect(
			renderHighlightedHtml(`<span class="hljs-comment">${text}</span>`, {
				comment: (value) => `[comment:${value}]`,
			}),
		).toBe(text);
	});

	// Regression for #10143: nested scope transitions must survive line breaks.
	it("restores parent formatting after multiline children and inherits it through unmapped spans", () => {
		const rendered = renderHighlightedHtml(
			'<span class="hljs-string">first\n<span class="language-template">' +
				'<span class="hljs-subst">inner\nvalue</span></span>' +
				'<span class="hljs-number">1\n2</span>tail\nlast</span>plain',
			{
				string: (text) => `[string:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		);
		expect(rendered).toBe(
			"[string:first]\n[string:inner]\n[string:value][number:1]\n[number:2][string:tail]\n[string:last]plain",
		);
	});

	// Regression for #10143: fallback formatters need the same line isolation as exact scopes.
	it.each(["comment.documentation", "comment-doc"])("formats multiline prefix scope %s", (scope) => {
		expect(
			renderHighlightedHtml(`<span class="hljs-${scope}">first\nsecond</span>`, {
				comment: (text) => `[comment:${text}]`,
			}),
		).toBe("[comment:first]\n[comment:second]");
	});

	// Regression for #10143: default formatting also covers multiline unscoped and unmapped text.
	it("applies default formatting independently to each line", () => {
		expect(
			renderHighlightedHtml('first\nsecond<span class="hljs-unknown">third\nfourth</span>\nlast', {
				default: (text) => `[default:${text}]`,
			}),
		).toBe("[default:first]\n[default:second][default:third]\n[default:fourth]\n[default:last]");
	});

	// Regression for #10143: decoded newlines must not bypass line isolation.
	it("decodes entities before applying multiline formatting", () => {
		const html = '<span class="hljs-string">&lt;&amp;&#13;&#10;&#xA;中文&gt;</span>';
		expect(renderHighlightedHtml(html, { string: (text) => `[string:${text}]` })).toBe(
			"[string:<&]\r\n\n[string:中文>]",
		);
		expect(renderHighlightedHtml(html)).toBe("<&\r\n\n中文>");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("theme syntax highlighting", () => {
	beforeAll(loadAllHighlightLanguages);

	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe(`${theme.getFgAnsi("toolDiffRemoved")}-old\x1b[39m`);
		expect(lines[1]).toBe(`${theme.getFgAnsi("toolDiffAdded")}+new\x1b[39m`);
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			`${theme.getFgAnsi("syntaxString")}/foo+/gi\x1b[39m`,
		);
		expect(highlightCode("@decorator", "python")[0]).toBe(`${theme.getFgAnsi("muted")}@decorator\x1b[39m`);
		expect(highlightCode("<div></div>", "html")[0]).toContain(`${theme.getFgAnsi("syntaxKeyword")}div\x1b[39m`);
	});

	// Regression for #10143: exercise real grammars through both tool and Markdown highlighting paths.
	it.each([
		["python", '"""first\nsecond\nthird"""', "syntaxString"],
		["javascript", "`first\nsecond\nthird`", "syntaxString"],
		["typescript", "`first\nsecond\nthird`", "syntaxString"],
		["bash", "'first\nsecond\nthird'", "syntaxString"],
		["lua", "[[first\nsecond\nthird]]", "syntaxString"],
		["ruby", '"first\nsecond\nthird"', "syntaxString"],
		["sql", "'first\nsecond\nthird'", "syntaxString"],
		["c", "/* first\nsecond\nthird */", "syntaxComment"],
		["rust", "/* first\nsecond\nthird */", "syntaxComment"],
		["html", "<!--first\nsecond\nthird-->", "syntaxComment"],
	] as const)("colors every line of a %s multiline token", (lang, code, color) => {
		const expected = code.split("\n").map((line) => theme.fg(color, line));
		expect(highlightCode(code, lang)).toEqual(expected);
		expect(getMarkdownTheme().highlightCode?.(code, lang)).toEqual(expected);
	});

	// Regression for #10143: closing nested interpolation must restore the multiline string style.
	it("keeps multiline template interpolation and surrounding code correctly colored", () => {
		const code = `\`first\n\${1}\nthird\`\nplain`;
		expect(highlightCode(code, "javascript")).toEqual([
			theme.fg("syntaxString", "`first"),
			theme.fg("syntaxString", "${") + theme.fg("syntaxNumber", "1") + theme.fg("syntaxString", "}"),
			theme.fg("syntaxString", "third`"),
			"plain",
		]);
	});

	// Regression for #10143: streamed unfinished tokens and blank lines retain their grammar context.
	it.each(['"""first\n\nlast', '"""first\n\nlast"""\n'])(
		"handles incomplete and trailing multiline content %j",
		(code) => {
			const expected = code.split("\n").map((line) => (line ? theme.fg("syntaxString", line) : ""));
			expect(highlightCode(code, "python")).toEqual(expected);
			expect(getMarkdownTheme().highlightCode?.(code, "python")).toEqual(expected);
		},
	);

	// Regression for #10143: the actual fenced-code renderer must preserve color after splitting and wrapping.
	it.each([80, 12])("preserves multiline string colors when Markdown renders at width %i", (width) => {
		const code = '"""first\nabcdefghijklmnopqrstuvwx\nlast"""';
		const markdown = new Markdown(`\`\`\`python\n${code}\n\`\`\`\n\nplain`, 0, 0, getMarkdownTheme());
		const lines = markdown.render(width);
		const plainLines = lines.map((line) => stripTerminalSequences(line).trimEnd());
		const closingFenceIndex = plainLines.lastIndexOf("```");
		expect(closingFenceIndex).toBeGreaterThan(3);

		for (const line of lines.slice(1, closingFenceIndex)) {
			if (stripTerminalSequences(line).trim()) {
				expect(line).toContain(theme.getFgAnsi("syntaxString"));
			}
		}
		expect(lines[closingFenceIndex]).not.toContain(theme.getFgAnsi("syntaxString"));
		expect(lines[plainLines.indexOf("plain")]).not.toContain(theme.getFgAnsi("syntaxString"));
		expect(
			plainLines
				.slice(1, closingFenceIndex)
				.map((line) => line.trimStart())
				.join(""),
		).toBe(code.replace(/\n/g, ""));
	});
});
