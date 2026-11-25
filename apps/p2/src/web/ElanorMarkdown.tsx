// Markdown in Elanor's components (the approach of pi.dev's docs, design-refresh): Markdown.tsx's elements mapped to
// Elanor's Prose, Text, Heading, List, Link, Strong, Emphasis, InlineCode, Blockquote, Separator, Table and
// CodeSnippet. p2's parser, its safety (raw HTML as text, remote images as links) and its streaming stay as they are.
import {
	Blockquote,
	Checkbox,
	CodeSnippet,
	CopyButton,
	Emphasis,
	Heading,
	InlineCode,
	Link,
	List,
	Prose,
	Separator,
	Strong,
	Table,
	Text,
} from "@earendil-works/elanor-react";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { highlightCode } from "./Code.tsx";
import type { MarkdownComponents } from "./Markdown.tsx";
import "./elanor-markdown.css";

/** GFM's column alignment as Elanor's logical one. */
const alignment = (align: unknown) => (align === "center" ? "center" : align === "right" ? "end" : "start");

/** A fenced code block: highlighted, with Copy. */
function ElanorCodeBlock({ code, language }: { code: string; language?: string }) {
	const content = useMemo(() => highlightCode(code, language), [code, language]);
	return (
		<CodeSnippet actions={<CopyButton value={code} aria-label="Copy code" />} data-language={language}>
			{content}
		</CodeSnippet>
	);
}

// Headings in an answer are serif, as the prose (Elanor's marketing style), and small: an answer is not a page.
// Markdown's # and ## (h3, h4 in Markdown.tsx) are size 5, deeper ones size 6, the text's own size.
const heading =
	(level: 3 | 4 | 5 | 6) =>
	({ className: _, ...props }: ComponentProps<"h3">) => (
		<Heading level={level} variant="marketing" size={level <= 4 ? 5 : 6} {...props} />
	);

type Cell = ComponentProps<"td"> & { "data-align"?: string };

export const ELANOR_MARKDOWN: MarkdownComponents = {
	root: (props: ComponentProps<"div">) => <Prose className="elanor-markdown" {...props} />,
	p: (props: ComponentProps<"p">) => <Text {...props} />,
	h3: heading(3),
	h4: heading(4),
	h5: heading(5),
	h6: heading(6),
	strong: (props: ComponentProps<"strong">) => <Strong {...props} />,
	em: (props: ComponentProps<"em">) => <Emphasis {...props} />,
	code: (props: ComponentProps<"code">) => <InlineCode {...props} />,
	a: (props: ComponentProps<"a">) => <Link {...props} />,
	ul: (props: ComponentProps<"ul">) => <List.Root {...props} />,
	ol: (props: ComponentProps<"ol">) => <List.Root render={<ol />} {...(props as ComponentProps<"ul">)} />,
	li: (props: ComponentProps<"li">) => <List.Item {...props} />,
	blockquote: (props: ComponentProps<"blockquote">) => <Blockquote {...props} />,
	// A quote's blocks sit in the quote directly: Prose spacing applies to them as to the answer's.
	quoteBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
	hr: () => <Separator />,
	tableWrap: ({ className: _, ...props }: ComponentProps<"div">) => <Table.Container {...props} />,
	table: (props: ComponentProps<"table">) => <Table.Root {...props} />,
	thead: (props: ComponentProps<"thead">) => <Table.Head {...props} />,
	tbody: (props: ComponentProps<"tbody">) => <Table.Body {...props} />,
	tr: (props: ComponentProps<"tr">) => <Table.Row {...props} />,
	// The HTML align attribute gives way to Elanor's logical alignment, from data-align.
	th: ({ className: _, align: _html, "data-align": align, ...props }: Cell) => (
		<Table.HeaderCell scope="col" align={alignment(align)} {...(props as Omit<ComponentProps<"th">, "align">)} />
	),
	td: ({ className: _, align: _html, "data-align": align, ...props }: Cell) => (
		<Table.Cell align={alignment(align)} {...props} />
	),
	codeBlock: ElanorCodeBlock,
	// A task item's checkbox shows its state; it is not a control here.
	checkbox: ({ checked }: { checked: boolean }) => (
		<Checkbox.Root
			className="markdown-checkbox"
			checked={checked}
			readOnly
			aria-label={checked ? "Done" : "Not done"}
		>
			<Checkbox.Indicator />
		</Checkbox.Root>
	),
};
