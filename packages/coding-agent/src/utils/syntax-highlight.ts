// Use the highlight.js core and register only the languages pi actually renders.
// The full index bundles ~190 language definitions; most sessions never touch most
// of them, so registering just the languages mapped from file extensions keeps the
// startup footprint and regex compilation down without changing what gets highlighted.
import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import clojure from "highlight.js/lib/languages/clojure.js";
import cmake from "highlight.js/lib/languages/cmake.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import css from "highlight.js/lib/languages/css.js";
import dockerfile from "highlight.js/lib/languages/dockerfile.js";
import elixir from "highlight.js/lib/languages/elixir.js";
import erlang from "highlight.js/lib/languages/erlang.js";
import go from "highlight.js/lib/languages/go.js";
import haskell from "highlight.js/lib/languages/haskell.js";
import ini from "highlight.js/lib/languages/ini.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import less from "highlight.js/lib/languages/less.js";
import lua from "highlight.js/lib/languages/lua.js";
import makefile from "highlight.js/lib/languages/makefile.js";
import markdown from "highlight.js/lib/languages/markdown.js";
import ocaml from "highlight.js/lib/languages/ocaml.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import plaintext from "highlight.js/lib/languages/plaintext.js";
import powershell from "highlight.js/lib/languages/powershell.js";
import protobuf from "highlight.js/lib/languages/protobuf.js";
import python from "highlight.js/lib/languages/python.js";
import r from "highlight.js/lib/languages/r.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import scss from "highlight.js/lib/languages/scss.js";
import sql from "highlight.js/lib/languages/sql.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import vim from "highlight.js/lib/languages/vim.js";
import xml from "highlight.js/lib/languages/xml.js";
import yaml from "highlight.js/lib/languages/yaml.js";
import { decodeHtmlEntityAt } from "./html.ts";

// Languages mapped from file extensions by getLanguageFromPath(), plus the
// modules whose aliases cover the remaining entries (xml -> html, ini -> toml).
// sass/fish/graphql/hcl are not registered by highlight.js's full index either,
// so those paths fall back to plain coloring exactly as before.
const REGISTERED_LANGUAGES: ReadonlyArray<[string, unknown]> = [
	["bash", bash],
	["c", c],
	["clojure", clojure],
	["cmake", cmake],
	["cpp", cpp],
	["csharp", csharp],
	["css", css],
	["dockerfile", dockerfile],
	["elixir", elixir],
	["erlang", erlang],
	["go", go],
	["haskell", haskell],
	["ini", ini],
	["java", java],
	["javascript", javascript],
	["json", json],
	["kotlin", kotlin],
	["less", less],
	["lua", lua],
	["makefile", makefile],
	["markdown", markdown],
	["ocaml", ocaml],
	["perl", perl],
	["php", php],
	["plaintext", plaintext],
	["powershell", powershell],
	["protobuf", protobuf],
	["python", python],
	["r", r],
	["ruby", ruby],
	["rust", rust],
	["scala", scala],
	["scss", scss],
	["sql", sql],
	["swift", swift],
	["typescript", typescript],
	["vim", vim],
	["xml", xml],
	["yaml", yaml],
];

for (const [name, definition] of REGISTERED_LANGUAGES) {
	hljs.registerLanguage(name, definition as never);
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
