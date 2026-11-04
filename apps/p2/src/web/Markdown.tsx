import { Lexer, type Token, type Tokens } from "marked";
import { type CSSProperties, createElement, Fragment, memo, type ReactNode, useMemo } from "react";
import { CodeBlock } from "./Code.tsx";

// Markdown (CommonMark with GitHub's tables, strikethrough, task lists and autolinks) parsed by marked and rendered as
// React elements: never HTML injection. Raw HTML stays visible as text, except a few attribute-less inline tags.
// Single newlines inside a paragraph are line breaks, as in chat clients.
const options = { gfm: true, breaks: true };

/** Inline tags written as raw HTML that render as themselves; they carry no attributes. */
const INLINE_TAGS = new Set(["b", "strong", "i", "em", "code", "kbd", "sub", "sup", "s", "del", "u", "mark", "small"]);

/** Named character references marked leaves encoded, for rendering without a document (server rendering, tests). */
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	times: "×",
	divide: "÷",
	deg: "°",
	plusmn: "±",
	middot: "·",
	bull: "•",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	rArr: "⇒",
	lArr: "⇐",
	hArr: "⇔",
	le: "≤",
	ge: "≥",
	ne: "≠",
	asymp: "≈",
	infin: "∞",
	minus: "−",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	sect: "§",
	para: "¶",
	check: "✓",
};
const decoder = typeof document === "undefined" ? undefined : document.createElement("textarea");
const decoded = new Map<string, string>();

/**
 * Text with character references decoded, numeric and named, in one pass: a decoded `&#38;copy;` stays `&copy;`. In
 * the browser every HTML entity is known: a textarea parses its content as text only, and the input is one reference.
 */
function entities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(
		/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
		(reference, decimal, hex, name) => {
			if (decimal !== undefined || hex !== undefined) {
				const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
				return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
					? "\ufffd"
					: String.fromCodePoint(code);
			}
			let value = decoded.get(reference);
			if (value === undefined) {
				if (decoder) {
					decoder.innerHTML = reference;
					value = decoder.value;
				} else value = NAMED[name] ?? reference;
				// Only references that decode are kept: their names are HTML's, so the cache stays bounded.
				if (value !== reference) decoded.set(reference, value);
			}
			return value;
		},
	);
}

/** Links open only web and mail addresses; anything else (javascript:, relative paths) stays text. */
function safeHref(href: string, autolink?: boolean): string | undefined {
	// Autolinks are literal; written destinations may contain character references (`&amp;` in a query).
	const target = (autolink ? href : entities(href)).trim();
	return /^(https?:|mailto:)/i.test(target) ? target : undefined;
}

/**
 * A leaf text token's text. marked decodes numeric references but not named ones; decoding its source instead keeps a
 * reference from being decoded twice. Anything else marked changed (it shouldn't) keeps marked's text.
 */
function leafText(token: Tokens.Text | Tokens.Generic): string {
	const raw = String(token.raw);
	const text = String(token.text);
	return raw === text ||
		raw.replace(/&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});/g, (reference) => entities(reference)) === text
		? entities(raw)
		: entities(text);
}

function inlineToken(token: Token, key: string, inLink = false): ReactNode {
	switch (token.type) {
		case "text":
			return token.tokens ? (
				<Fragment key={key}>{inline(token.tokens, key, inLink)}</Fragment>
			) : (
				<Fragment key={key}>{token.escaped ? token.text : leafText(token)}</Fragment>
			);
		case "checkbox":
			// A loose task item's checkbox arrives inside its first paragraph.
			return <input key={key} type="checkbox" checked={Boolean(token.checked)} disabled readOnly />;
		case "escape":
			return <Fragment key={key}>{token.text}</Fragment>;
		case "strong":
			return <strong key={key}>{inline(token.tokens, key, inLink)}</strong>;
		case "em":
			return <em key={key}>{inline(token.tokens, key, inLink)}</em>;
		case "del":
			return <del key={key}>{inline(token.tokens, key, inLink)}</del>;
		case "codespan":
			return <code key={key}>{token.text}</code>;
		case "br":
			return <br key={key} />;
		case "link": {
			// Footnotes are not supported: `[^1]` stays as written instead of linking to a definition's text.
			if (/^\[\^[^\]]+\]$/.test(token.raw)) return <Fragment key={key}>{token.raw}</Fragment>;
			const href = inLink ? undefined : safeHref(token.href, token.autolink);
			const children = inline(token.tokens, key, true);
			return href ? (
				<a key={key} href={href} title={token.title ?? undefined} target="_blank" rel="noreferrer">
					{children}
				</a>
			) : (
				<Fragment key={key}>{children}</Fragment>
			);
		}
		case "image": {
			// Remote images are not loaded: a link to them, named by their description; inside a link (a badge), its label.
			const href = inLink ? undefined : safeHref(token.href);
			const label = token.text || token.href;
			return href ? (
				<a key={key} href={href} title={token.title ?? undefined} target="_blank" rel="noreferrer">
					{label}
				</a>
			) : (
				<Fragment key={key}>{label}</Fragment>
			);
		}
		default:
			return <Fragment key={key}>{token.raw}</Fragment>;
	}
}

/** A raw tag written alone: `<b>`, `</b>` or `<br/>`, without attributes. */
function rawTag(text: string): { name: string; closing: boolean; self: boolean } | undefined {
	const tag = /^<(\/?)([a-z][a-z0-9]*)\s*(\/?)>$/i.exec(text.trim());
	return tag?.[2] ? { name: tag[2].toLowerCase(), closing: tag[1] === "/", self: tag[3] === "/" } : undefined;
}

/**
 * Inline tokens. Allowed raw tags become elements only with their closing tag, nested at most eight deep; anything
 * else stays literal text. Pairs are found first, so building is one pass with nothing moved afterwards.
 */
function inline(tokens: readonly Token[] | undefined, key: string, inLink = false): ReactNode[] {
	const list = tokens ?? [];
	const closes = new Map<number, number>();
	const unclosed: { name: string; index: number }[] = [];
	list.forEach((token, index) => {
		const tag = token.type === "html" ? rawTag(token.text) : undefined;
		if (!tag || !INLINE_TAGS.has(tag.name) || tag.self) return;
		if (!tag.closing) {
			if (unclosed.length < 8) unclosed.push({ name: tag.name, index });
		} else if (unclosed.at(-1)?.name === tag.name) {
			const open = unclosed.pop();
			if (open) closes.set(open.index, index);
		}
	});
	const root: ReactNode[] = [];
	const elements: { tag: string; id: string; close: number; children: ReactNode[] }[] = [];
	list.forEach((token, index) => {
		const id = `${key}-${index}`;
		const out = elements.at(-1)?.children ?? root;
		const close = closes.get(index);
		if (close !== undefined) {
			elements.push({ tag: rawTag(token.raw)?.name ?? "span", id, close, children: [] });
			return;
		}
		const element = elements.at(-1);
		if (element?.close === index) {
			elements.pop();
			(elements.at(-1)?.children ?? root).push(createElement(element.tag, { key: element.id }, element.children));
			return;
		}
		const tag = token.type === "html" ? rawTag(token.text) : undefined;
		if (token.type !== "html") out.push(inlineToken(token, id, inLink));
		// Comments are hidden, as on GitHub.
		else if (/^<!--[\s\S]*-->$/.test(token.text.trim())) return;
		else if (tag?.name === "br" && !tag.closing) out.push(<br key={id} />);
		else out.push(<Fragment key={id}>{token.raw}</Fragment>);
	});
	return root;
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
	return (
		<li key={key} className={item.task ? "task" : undefined}>
			{item.tokens.map((child, index) => {
				const id = `${key}-${index}`;
				if (child.type === "checkbox")
					return <input key={id} type="checkbox" checked={Boolean(child.checked)} disabled readOnly />;
				// A tight item's text is inline; nested blocks (lists, code, paragraphs of loose items) follow it.
				if (child.type === "text") return <Fragment key={id}>{inlineToken(child, id)}</Fragment>;
				return block(child, id);
			})}
		</li>
	);
}

function block(token: Token, key: string): ReactNode {
	switch (token.type) {
		case "space":
			return null;
		case "def":
			// Definitions are hidden, except footnotes (unsupported), which stay as written.
			return String(token.tag).startsWith("^") ? <p key={key}>{token.raw.trimEnd()}</p> : null;
		case "heading": {
			const Tag = `h${Math.min(token.depth + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
			return <Tag key={key}>{inline(token.tokens, key)}</Tag>;
		}
		case "paragraph":
		case "text":
			return <p key={key}>{token.tokens ? inline(token.tokens, key) : entities(token.text)}</p>;
		case "code":
			return <CodeBlock key={key} code={token.text} language={token.lang?.split(/\s/)[0] || undefined} />;
		case "blockquote":
			return (
				<blockquote key={key}>
					<div className="md">
						{(token as Tokens.Blockquote).tokens.map((child, index) => block(child, `${key}-${index}`))}
					</div>
				</blockquote>
			);
		case "hr":
			return <hr key={key} />;
		case "list": {
			const items = (token.items as Tokens.ListItem[]).map((item, index) => listItem(item, `${key}-${index}`));
			if (!token.ordered) return <ul key={key}>{items}</ul>;
			const start = typeof token.start === "number" ? token.start : 1;
			// Room for the widest marker: "10." needs more than "9.".
			const digits = String(start + items.length - 1).length;
			return (
				<ol
					key={key}
					start={start === 1 ? undefined : start}
					style={digits > 1 ? ({ "--digits": digits } as CSSProperties) : undefined}
				>
					{items}
				</ol>
			);
		}
		case "table": {
			const table = token as Tokens.Table;
			const align = (cell: Tokens.TableCell) => `align-${cell.align ?? "left"}`;
			return (
				<div className="table-wrap" key={key}>
					<table>
						<thead>
							<tr>
								{table.header.map((cell, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a parsed table's cells never move.
									<th className={align(cell)} key={`${key}-head-${index}`}>
										{inline(cell.tokens, `${key}-head-${index}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{table.rows.map((row, rowIndex) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a parsed table's rows never move.
								<tr key={`${key}-row-${rowIndex}`}>
									{row.map((cell, cellIndex) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a parsed table's cells never move.
										<td className={align(cell)} key={`${key}-${rowIndex}-${cellIndex}`}>
											{inline(cell.tokens, `${key}-${rowIndex}-${cellIndex}`)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		case "html": {
			// Raw HTML blocks stay visible as written, line by line; comments are hidden, as on GitHub. A lone tag
			// line that inline HTML supports (<br>, <b>…</b>) renders as it would inside a paragraph.
			const text = String(token.text).trimEnd();
			if (/^<!--[\s\S]*-->$/.test(text)) return null;
			return (
				<p key={key}>
					{text.split("\n").map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines of one block never move.
						<Fragment key={`${key}-${index}`}>
							{index > 0 && <br />}
							{inline(Lexer.lexInline(line, options), `${key}-${index}`)}
						</Fragment>
					))}
				</p>
			);
		}
		default:
			return <p key={key}>{token.raw}</p>;
	}
}

/**
 * One top-level block with the link definitions it may reference, parsed and rendered only when that source changes:
 * while a message streams, only its last block does.
 */
const MarkdownBlock = memo(function MarkdownBlock({ source }: { source: string }) {
	return Lexer.lex(source, options).map((token, index) => block(token, `b${index}`));
});

/**
 * The sources of a message's top-level blocks. Only block boundaries are found here (marked's inline pass, the costly
 * part, runs per block); link definitions are appended to blocks that may reference them. Footnote definitions stay
 * blocks of their own: footnotes are shown as written.
 */
function splitMarkdown(text: string): string[] {
	const tokens = new Lexer(options).blockTokens(text.replace(/\r\n?/g, "\n"), []);
	const references = (token: Token) => token.type === "def" && !String(token.tag).startsWith("^");
	const definitions = tokens
		.filter(references)
		.map((token) => token.raw.trimEnd())
		.join("\n");
	return tokens
		.filter((token) => token.type !== "space" && !references(token))
		.map((token) => (definitions && token.raw.includes("[") ? `${token.raw}\n\n${definitions}` : token.raw));
}

// Memoized by text: transcript rebuilds during streaming keep unchanged messages unparsed.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => splitMarkdown(text), [text]);
	return (
		<div className="md">
			{blocks.map((source, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: blocks only grow at the end while a message streams.
				<MarkdownBlock key={index} source={source} />
			))}
		</div>
	);
});
