// What panes share, in the views plugin and in other plugins' panes (an html artifact's): the person's text selection
// reported as the view's selection. Other plugins' web facets import it (copied into their scripts), so it holds no state
// of its own: the views plugin's page state is reached through `ViewsPages` (contract.web.ts).
import type { JsonValue } from "@p2/app/v1";
import { type PaneProps, useRegistry } from "@p2/app/v1/web";
import { type RefObject, useEffect, useRef } from "react";
import { ViewsPages } from "./contract.web.ts";

/** How long a selection rests before it is reported (a drag selects many times). */
const SELECTION_PAUSE = 600;

/**
 * Reports the person's text selection inside `body`, described by `describe`, after it rests; not while they annotate
 * (that selection is what a comment or removal quotes).
 */
export function usePaneSelection(
	body: RefObject<HTMLElement | null>,
	describe: (quote: string, element: Element | null) => { summary: string; data: JsonValue },
	select: PaneProps["select"],
): void {
	const page = useRegistry(ViewsPages).get("views");
	const latest = useRef({ describe, select, page });
	latest.current = { describe, select, page };
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let reported = "";
		const changed = () => {
			const selection = getSelection();
			if (latest.current.page?.annotating() !== false || !selection?.rangeCount || selection.isCollapsed) return;
			const node = selection.getRangeAt(0).commonAncestorContainer;
			const element = node instanceof Element ? node : node.parentElement;
			if (!body.current?.contains(element)) return;
			const quote = selection.toString().trim().slice(0, 4000);
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (!quote || quote === reported) return;
				reported = quote;
				latest.current.select(latest.current.describe(quote, element));
			}, SELECTION_PAUSE);
		};
		document.addEventListener("selectionchange", changed);
		return () => {
			document.removeEventListener("selectionchange", changed);
			clearTimeout(timer);
		};
	}, [body]);
}

/** A quote as a selection's summary shows it: one line in quotation marks, cut at 300 characters. */
export const excerpt = (text: string) => {
	const line = text.replace(/\s+/g, " ").trim();
	return `“${line.length > 300 ? `${line.slice(0, 300)}…` : line}”`;
};
