import { common, createLowlight } from "lowlight";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons.tsx";

const lowlight = createLowlight(common);
const ALIASES: Record<string, string> = { mjs: "js", cjs: "js", mts: "ts", cts: "ts", jsonc: "json", zsh: "bash" };

/** Highlight.js language for a fence info string or a file path, if registered. */
function languageOf(hint: string | undefined): string | undefined {
	if (!hint) return undefined;
	const name = hint.toLowerCase().split(/[\s{]/)[0]?.split(/[/\\]/).pop() ?? "";
	const key = name.includes(".") ? (name.split(".").pop() ?? "") : name;
	const language = ALIASES[key] ?? key;
	return language && lowlight.registered(language) ? language : undefined;
}

type HastNode = {
	type: string;
	value?: string;
	properties?: { className?: unknown };
	children?: HastNode[];
};

function render(nodes: readonly HastNode[], key: string): ReactNode[] {
	return nodes.map((node, index) => {
		const id = `${key}.${index}`;
		if (node.type === "text") return node.value ?? "";
		const className = Array.isArray(node.properties?.className) ? node.properties.className.join(" ") : undefined;
		return (
			<span key={id} className={className}>
				{render(node.children ?? [], id)}
			</span>
		);
	});
}

// Rendered as React elements from lowlight's tree: never as HTML.
function highlight(code: string, language: string | undefined): ReactNode {
	if (!language || code.length > 100_000) return code;
	try {
		return render(lowlight.highlight(language, code).children as unknown as HastNode[], "h");
	} catch {
		return code;
	}
}

export function DiffBlock({ diff, language }: { diff: string; language?: string }) {
	const resolved = languageOf(language);
	const rows = useMemo(
		() =>
			diff.split("\n").map((line) => {
				// Durable's display diff prefixes source with +/- and a padded line number.
				// Keep that gutter outside the language lexer; also accept plain +/- diffs.
				const prefix = /^[ +-]\s*\d+ /.exec(line)?.[0] ?? /^[ +-]/.exec(line)?.[0] ?? "";
				return {
					prefix,
					content: highlight(line.slice(prefix.length), diff.length > 100_000 ? undefined : resolved),
					kind: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "",
				};
			}),
		[diff, resolved],
	);
	return (
		<pre className="diff hljs">
			<code className="diff-lines">
				{rows.map((row, index) => (
					<span key={`${index}:${row.prefix}`} className={`diff-line ${row.kind}`}>
						{row.prefix}
						{row.content}
						{"\n"}
					</span>
				))}
			</code>
		</pre>
	);
}

/** One rendered line of a file or patch; `number` is its line in the file version shown (deleted lines: old). */
export type CodeLine = { kind: "" | "add" | "del" | "hunk" | "meta"; number?: number; text: string };

/**
 * A git unified patch as lines: the new line number for context and additions, the
 * old one for deletions. Git's file headers are dropped (the caller shows the path);
 * hunk headers stay as separators unless `full` (whole-file context) makes them noise.
 */
export function patchLines(patch: string, full = false): CodeLine[] {
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	const lines: CodeLine[] = [];
	for (const line of (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			if (!full) lines.push({ kind: "hunk", text: line });
		} else if (!inHunk || line.startsWith("diff --git ")) {
			inHunk = false;
			// Only notes a reader needs survive from the file header.
			if (/^(Binary files|similarity index|rename from|rename to|old mode|new mode)/.test(line))
				lines.push({ kind: "meta", text: line });
		} else if (line.startsWith("\\")) lines.push({ kind: "meta", text: line });
		else {
			const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
			const number = kind === "del" ? oldLine++ : newLine++;
			if (kind === "") oldLine++;
			lines.push({ kind, number, text: line.slice(1) });
		}
	}
	return lines;
}

export function textLines(text: string): CodeLine[] {
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").map((line, index) => ({
		kind: "",
		number: index + 1,
		text: line,
	}));
}

/**
 * Lines with one compact gutter, sized to the largest number. Each row is a grid, so
 * wrapped code keeps its indent instead of flowing back under the gutter. With
 * `onLine`, numbers are buttons (for selecting lines); `after` renders content
 * below a line, such as review comments.
 */
export function LinesBlock({
	lines,
	language,
	selected,
	marked,
	onLine,
	onHunk,
	after,
}: {
	lines: CodeLine[];
	language?: string;
	/** Index of a line to highlight, such as a search hit. */
	marked?: number;
	/** Hunk separators become buttons that load more context. */
	onHunk?: () => void;
	selected?: (index: number) => boolean;
	onLine?: (index: number) => void;
	after?: (index: number) => ReactNode;
}) {
	const resolved = languageOf(language);
	const size = lines.reduce((total, line) => total + line.text.length, 0);
	const highlighted = useMemo(
		() =>
			lines.map((line) =>
				line.kind === "hunk" || line.kind === "meta"
					? line.text
					: highlight(line.text, size > 200_000 ? undefined : resolved),
			),
		[lines, resolved, size],
	);
	const digits = String(lines.reduce((widest, line) => Math.max(widest, line.number ?? 0), 1)).length;
	return (
		<pre className="diff patch hljs" style={{ "--gutter": `${digits}ch` } as CSSProperties}>
			<code className="diff-lines">
				{lines.map((line, index) => (
					<Fragment key={`${index}:${line.kind}`}>
						<span
							className={`diff-line ${line.kind} ${selected?.(index) ? "selected" : ""} ${marked === index ? "marked" : ""}`}
						>
							{onLine && line.number !== undefined ? (
								<button
									type="button"
									className="diff-number"
									onClick={() => onLine(index)}
									aria-label={`Line ${line.number}`}
								>
									{line.number}
								</button>
							) : (
								<span className="diff-number">{line.number}</span>
							)}
							{line.kind === "hunk" && onHunk ? (
								<button type="button" className="diff-code" onClick={onHunk} title="Show more context">
									{highlighted[index]} ⋯
								</button>
							) : (
								<span className="diff-code">{highlighted[index]}</span>
							)}
						</span>
						{after?.(index)}
					</Fragment>
				))}
			</code>
		</pre>
	);
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API unavailable (insecure context, permissions): legacy fallback.
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const copied = document.execCommand("copy");
		area.remove();
		return copied;
	}
}

/** Icon-only copy in content; `primary` renders an outline button when copying is the sheet's main action. */
export function CopyButton({ text, label, primary }: { text: string; label?: string; primary?: boolean }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className={`${primary ? "button" : "copy"} ${copied ? "done" : ""}`}
			aria-label={copied ? "Copied" : "Copy"}
			onClick={() => {
				void copyText(text).then(setCopied);
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
			{label && <span>{copied ? "Copied" : label}</span>}
		</button>
	);
}

export function CodeBlock({ code, language, tool }: { code: string; language?: string; tool?: boolean }) {
	const resolved = languageOf(language);
	const content = useMemo(() => highlight(code, resolved), [code, resolved]);
	if (tool)
		return (
			<pre className="code hljs">
				<code>{content}</code>
			</pre>
		);
	return (
		<div className="code-block">
			<div className="code-head">
				<span>{language || "text"}</span>
				<CopyButton text={code} label="Copy" />
			</div>
			<pre className="hljs">
				<code>{content}</code>
			</pre>
		</div>
	);
}
