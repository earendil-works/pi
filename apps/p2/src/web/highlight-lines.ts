// Highlighting a file or patch line by line in context: each text is highlighted once and its tree split into lines, so
// a token spanning lines (a block comment, a template literal) keeps its class on every line.
import type { CodeLine } from "./Code.tsx";

/** A node of lowlight's (hast) tree: text, or an element with its classes and children. */
export type HastNode = {
	type: string;
	value?: string;
	properties?: { className?: unknown };
	children?: HastNode[];
};

/** Highlights one text as lowlight's tree; `undefined` when it cannot. */
export type Highlighter = (text: string) => readonly HastNode[] | undefined;

/**
 * Each line highlighted in its context (plain text where `highlighter` cannot): between hunk and meta lines, which stay
 * plain, the new side (context and added lines) and the old side (context and deleted lines) are each highlighted as one
 * text; a line takes its row of its side (context lines the new side's). A file's lines are all context.
 */
export function highlightLines(lines: readonly CodeLine[], highlighter: Highlighter): (readonly HastNode[] | string)[] {
	const shown: (readonly HastNode[] | string)[] = lines.map((line) => line.text);
	let start = 0;
	for (let end = 0; end <= lines.length; end++) {
		const kind = lines[end]?.kind;
		if (kind !== undefined && kind !== "hunk" && kind !== "meta") continue;
		const rows = [...Array(end - start).keys()].map((offset) => start + offset);
		const newSide = rows.filter((row) => lines[row]!.kind !== "del");
		const oldSide = rows.filter((row) => lines[row]!.kind !== "add");
		highlightSide(lines, newSide, highlighter, shown, () => true);
		if (oldSide.some((row) => lines[row]!.kind === "del"))
			highlightSide(lines, oldSide, highlighter, shown, (row) => lines[row]!.kind === "del");
		start = end + 1;
	}
	return shown;
}

/** Highlights `rows` of `lines` as one text and puts the lines `keep` takes into `shown`. */
function highlightSide(
	lines: readonly CodeLine[],
	rows: readonly number[],
	highlighter: Highlighter,
	shown: (readonly HastNode[] | string)[],
	keep: (row: number) => boolean,
): void {
	if (rows.length === 0) return;
	const tree = highlighter(rows.map((row) => lines[row]!.text).join("\n"));
	if (tree === undefined) return;
	const split = splitLines(tree);
	rows.forEach((row, index) => {
		if (keep(row)) shown[row] = split[index] ?? [];
	});
}

/**
 * Lowlight's tree split at its newlines into one tree per line: the spans open at a line break are opened again on the
 * next line (their classes copied), so every line has its own span stack.
 */
export function splitLines(nodes: readonly HastNode[]): HastNode[][] {
	const lines: HastNode[][] = [[]];
	// The current line's copies of the spans open here, outermost first.
	let open: HastNode[] = [];
	const append = (node: HastNode): void => {
		(open.at(-1)?.children ?? lines.at(-1)!).push(node);
	};
	const breakLine = (): void => {
		lines.push([]);
		const reopened: HastNode[] = [];
		for (const span of open) {
			const copy: HastNode = { type: span.type, properties: span.properties, children: [] };
			(reopened.at(-1)?.children ?? lines.at(-1)!).push(copy);
			reopened.push(copy);
		}
		open = reopened;
	};
	const walk = (list: readonly HastNode[]): void => {
		for (const node of list) {
			if (node.type === "text") {
				(node.value ?? "").split("\n").forEach((part, index) => {
					if (index > 0) breakLine();
					if (part !== "") append({ type: "text", value: part });
				});
				continue;
			}
			const copy: HastNode = { type: node.type, properties: node.properties, children: [] };
			append(copy);
			open.push(copy);
			walk(node.children ?? []);
			open.pop();
		}
	};
	walk(nodes);
	return lines;
}
