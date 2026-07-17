/**
 * Unicode formula rendering for assistant messages.
 *
 * Converts common TeX notation inside \(...\), \[...\], $...$, and $$...$$
 * to readable Unicode before Pi's built-in assistant renderer runs.
 * Code spans and fenced code blocks are left unchanged. Unsupported TeX
 * remains visible.
 *
 * Usage:
 *   pi -e examples/extensions/unicode-math.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Marked, type Token } from "marked";

const markdownParser = new Marked();

const TEX_SYMBOLS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ϵ",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	sigma: "σ",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "ϕ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	in: "∈",
	notin: "∉",
	ni: "∋",
	sum: "∑",
	prod: "∏",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	oint: "∮",
	pm: "±",
	mp: "∓",
	times: "×",
	cdot: "·",
	div: "÷",
	ast: "∗",
	circ: "∘",
	bullet: "•",
	le: "≤",
	leq: "≤",
	ge: "≥",
	geq: "≥",
	ne: "≠",
	neq: "≠",
	approx: "≈",
	equiv: "≡",
	propto: "∝",
	sim: "∼",
	simeq: "≃",
	cong: "≅",
	ll: "≪",
	gg: "≫",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	cup: "∪",
	cap: "∩",
	setminus: "∖",
	emptyset: "∅",
	land: "∧",
	lor: "∨",
	neg: "¬",
	oplus: "⊕",
	otimes: "⊗",
	perp: "⊥",
	parallel: "∥",
	angle: "∠",
	therefore: "∴",
	because: "∵",
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	mapsto: "↦",
	ldots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
};

const BLACKBOARD_SYMBOLS: Record<string, string> = {
	C: "ℂ",
	H: "ℍ",
	N: "ℕ",
	P: "ℙ",
	Q: "ℚ",
	R: "ℝ",
	Z: "ℤ",
};

function createCharacterMap(...groups: Array<readonly [plain: string, mapped: string]>): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const [plain, mapped] of groups) {
		const plainCharacters = Array.from(plain);
		const mappedCharacters = Array.from(mapped);
		if (plainCharacters.length !== mappedCharacters.length) {
			throw new Error(`Character map length mismatch: ${plain} -> ${mapped}`);
		}
		entries.push(
			...plainCharacters.map((character, index): [string, string] => [character, mappedCharacters[index]!]),
		);
	}
	return Object.fromEntries(entries);
}

const SUPERSCRIPT = createCharacterMap(
	["0123456789+-=()", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾"],
	["abcdefghijklmnopqrstuvwxyz", "ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖ𐞥ʳˢᵗᵘᵛʷˣʸᶻ"],
	["ABCDEFGHIJKLMNOPQRSTUVW", "ᴬᴮꟲᴰᴱꟳᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾꟴᴿ꟱ᵀᵁⱽᵂ"],
	["αβγδεθφχ", "ᵅᵝᵞᵟᵋᶿᵠᵡ"],
);

const SUBSCRIPT = createCharacterMap(
	["0123456789+-=()", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"],
	["aehijklmnoprstuvx", "ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"],
	["βγρφχ", "ᵦᵧᵨᵩᵪ"],
);

function mapScript(value: string, table: Record<string, string>, marker: string): string {
	const mapped = Array.from(value, (character) => table[character]);
	return mapped.every((character) => character !== undefined) ? mapped.join("") : `${marker}${value}`;
}

function replaceSimpleCommands(tex: string): string {
	return tex.replace(/\\([A-Za-z]+)/g, (match, name: string) => TEX_SYMBOLS[name] ?? match);
}

function renderEnvironment(name: string, body: string): string {
	const rows = body
		.trim()
		.split(/\\\\/)
		.map((row) => row.trim())
		.filter(Boolean)
		.map((row) => row.split("&").map((cell) => texToUnicode(cell)));

	if (name === "aligned") {
		return rows.map((cells) => cells.join(" ")).join("\n");
	}
	if (name === "pmatrix") {
		return rows
			.map((cells, index) => {
				const left = rows.length === 1 ? "(" : index === 0 ? "⎛" : index === rows.length - 1 ? "⎝" : "⎜";
				const right = rows.length === 1 ? ")" : index === 0 ? "⎞" : index === rows.length - 1 ? "⎠" : "⎟";
				return `${left}${cells.join(" ")}${right}`;
			})
			.join("\n");
	}
	return rows
		.map((cells, index) => {
			const brace = rows.length === 1 ? "{" : index === 0 ? "⎧" : index === rows.length - 1 ? "⎩" : "⎪";
			return `${brace} ${cells.join(" ")}`;
		})
		.join("\n");
}

/** Convert a useful subset of TeX notation to Unicode. */
export function texToUnicode(source: string): string {
	let text = source
		.trim()
		.replace(
			/(^|\n)(?:([^\n]*=)[ \t]*\n[ \t]*)?\\begin\{(aligned|pmatrix|cases)\}([\s\S]*?)\\end\{\3\}/g,
			(_match, lineStart: string, prefix: string | undefined, name: string, body: string) => {
				const rendered = renderEnvironment(name, body);
				if (prefix === undefined) return lineStart + rendered;
				const label = `${texToUnicode(prefix)} `;
				return lineStart + label + rendered.replace(/\n/g, `\n${" ".repeat(Array.from(label).length)}`);
			},
		);

	while (true) {
		const next = text
			.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)⁄($2)")
			.replace(/\\sqrt\[([^{}]*)\]\{([^{}]*)\}/g, (_match, degree: string, value: string) => {
				return `${mapScript(degree, SUPERSCRIPT, "^")}√(${value})`;
			})
			.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
		if (next === text) break;
		text = next;
	}

	text = text
		.replace(/\\mathbb\{([^{}])\}/g, (_match, symbol: string) => BLACKBOARD_SYMBOLS[symbol] ?? symbol)
		.replace(/\\(?:mathrm|mathbf|mathit|mathsf|mathtt|text|operatorname)\{([^{}]*)\}/g, "$1")
		.replace(/\\(?:left|right)\b/g, "")
		.replace(/\\(?:quad|qquad)\b/g, " ")
		.replace(/\\[,;:!]/g, " ")
		.replace(/\\\\/g, "\n");

	text = replaceSimpleCommands(text);
	text = text
		.replace(
			/([∑∏∫∬∭∮])\s*_(?:\{([^{}]+)\}|([^\s^_]))\s*\^(?:\{([^{}]+)\}|([^\s^_]))/g,
			(_match, operator: string, lowerGroup: string, lowerSingle: string, upperGroup: string, upperSingle: string) =>
				`${operator}[${lowerGroup ?? lowerSingle}…${upperGroup ?? upperSingle}]`,
		)
		.replace(
			/([∑∏∫∬∭∮])\s*\^(?:\{([^{}]+)\}|([^\s^_]))\s*_(?:\{([^{}]+)\}|([^\s^_]))/g,
			(_match, operator: string, upperGroup: string, upperSingle: string, lowerGroup: string, lowerSingle: string) =>
				`${operator}[${lowerGroup ?? lowerSingle}…${upperGroup ?? upperSingle}]`,
		)
		.replace(
			/([∑∏∫∬∭∮])\s*_(?:\{([^{}]+)\}|([^\s^_]))/g,
			(_match, operator: string, group: string, single: string) => `${operator}[${group ?? single}]`,
		)
		.replace(
			/([∑∏∫∬∭∮])\s*\^(?:\{([^{}]+)\}|([^\s^_]))/g,
			(_match, operator: string, group: string, single: string) => `${operator}[…${group ?? single}]`,
		);
	text = text.replace(/([_^])(?:\{([^{}]+)\}|([^\s{}_^]))/g, (_match, marker, group, single) => {
		const value = marker === "^" ? (group ?? single).replace(/\^/g, "") : (group ?? single);
		return marker === "^" ? mapScript(value, SUPERSCRIPT, "^") : mapScript(value, SUBSCRIPT, "_");
	});

	return text
		.replace(/~/g, " ")
		.replace(/(?<=\S)[ \t]+/g, " ")
		.trim();
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

function findClosingDelimiter(text: string, start: number, delimiter: "$" | "$$"): number {
	for (let index = text.indexOf(delimiter, start); index !== -1; index = text.indexOf(delimiter, index + 1)) {
		if (isEscaped(text, index)) continue;
		if (delimiter === "$" && text[index + 1] === "$") continue;
		return index;
	}
	return -1;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_[\]<>#]/g, "\\$&");
}

function renderUnicodeMathText(text: string): string {
	let result = "";
	let index = 0;

	while (index < text.length) {
		if (text[index] === "$" && !isEscaped(text, index)) {
			const display = text[index + 1] === "$";
			const delimiter = display ? "$$" : "$";
			const contentStart = index + delimiter.length;
			const close = findClosingDelimiter(text, contentStart, delimiter);
			if (close !== -1) {
				const content = text.slice(contentStart, close);
				const validInline =
					display ||
					(!content.includes("\n") &&
						content.length > 0 &&
						!/^\s/.test(content) &&
						!/^\d+(?:[.,]\d+)?$/.test(content) &&
						!(/\s$/.test(content) || /\d/.test(text[close + 1] ?? "")));
				if (validInline) {
					const rendered = escapeMarkdown(texToUnicode(content));
					result += display ? `\n\n${rendered}\n\n` : rendered;
					index = close + delimiter.length;
					continue;
				}
			}
		}

		const bracketDelimiter = text.slice(index, index + 2);
		if ((bracketDelimiter === "\\(" || bracketDelimiter === "\\[") && !isEscaped(text, index)) {
			const closingDelimiter = bracketDelimiter === "\\(" ? "\\)" : "\\]";
			const contentStart = index + bracketDelimiter.length;
			const close = text.indexOf(closingDelimiter, contentStart);
			if (close !== -1) {
				const content = text.slice(contentStart, close);
				if (bracketDelimiter === "\\[" || !content.includes("\n")) {
					const rendered = escapeMarkdown(texToUnicode(content));
					result += bracketDelimiter === "\\[" ? `\n\n${rendered}\n\n` : rendered;
					index = close + closingDelimiter.length;
					continue;
				}
			}
		}

		result += text[index];
		index++;
	}

	return result;
}

function getChildTokens(token: Token): Token[] {
	if (token.type === "list") {
		return token.items;
	}
	if (token.type === "table") {
		return [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens);
	}
	if ("tokens" in token && Array.isArray(token.tokens)) {
		return token.tokens;
	}
	return [];
}

function renderTokenChildren(source: string, tokens: readonly Token[]): string {
	let result = "";
	let searchOffset = 0;
	let outputOffset = 0;
	for (const token of tokens) {
		const index = source.indexOf(token.raw, searchOffset);
		if (index === -1) return source;
		searchOffset = index + token.raw.length;
		if (token.type === "text" || token.type === "escape" || token.type === "br") {
			continue;
		}
		result += renderUnicodeMathText(source.slice(outputOffset, index)) + renderUnicodeMathToken(token);
		outputOffset = searchOffset;
	}
	return result + renderUnicodeMathText(source.slice(outputOffset));
}

function renderLinkText(raw: string, tokens: readonly Token[]): string {
	const firstChild = tokens[0];
	if (!firstChild) return raw;

	let searchOffset = 0;
	let textStart = -1;
	let textEnd = -1;
	for (const child of tokens) {
		const index = raw.indexOf(child.raw, searchOffset);
		if (index === -1) return raw;
		if (textStart === -1) textStart = index;
		textEnd = index + child.raw.length;
		searchOffset = textEnd;
	}

	return raw.slice(0, textStart) + renderTokenChildren(raw.slice(textStart, textEnd), tokens) + raw.slice(textEnd);
}

function renderUnicodeMathToken(token: Token): string {
	if (token.type === "code" || token.type === "codespan" || token.type === "html" || token.type === "def") {
		return token.raw;
	}

	// Autolinks and bare URLs use the same source text for their label and destination,
	// so changing their child text would also change the link target.
	if (token.type === "link" && !token.raw.startsWith("[")) {
		return token.raw;
	}
	if ((token.type === "link" || token.type === "image") && "tokens" in token && Array.isArray(token.tokens)) {
		return renderLinkText(token.raw, token.tokens);
	}

	const childTokens = getChildTokens(token);
	if (childTokens.length > 0) {
		return renderTokenChildren(token.raw, childTokens);
	}
	return token.type === "text" || token.type === "escape" || token.type === "br"
		? renderUnicodeMathText(token.raw)
		: token.raw;
}

/** Replace formulas in Markdown text while preserving code, links, and raw HTML. */
export function renderUnicodeMath(markdown: string): string {
	return markdownParser.lexer(markdown).map(renderUnicodeMathToken).join("");
}

export default function (pi: ExtensionAPI) {
	pi.registerAssistantMarkdownTransformer((markdown, { contentType }) => {
		return contentType === "text" ? renderUnicodeMath(markdown) : markdown;
	});
}
