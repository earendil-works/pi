// The command menu's highlighted option, kept in the DOM rather than React state: `aria-selected="true"` on one
// `[role=option]` of the listbox and the input's `aria-activedescendant`. Moving it re-renders nothing, and the rows of
// pages and searches, which render on their own, need not report themselves. Until the reader moves it (a key, the
// pointer), the highlight is the first option, also when rows appear above it later (a `Shown` row, a page's data);
// the listbox's `data-moved` says that the reader moved it. Enter clicks the highlighted option; pressed before the
// typed text's rows rendered, it clicks the first one that does (`enter`).

const OPTION = '[role="option"]';
const SELECTED = '[role="option"][aria-selected="true"]';

/** The highlighted option of `list`, if any. */
const highlighted = (list: HTMLElement): HTMLElement | null => list.querySelector<HTMLElement>(SELECTED);

/**
 * An Enter that found no option, by listbox: the text it was pressed on and when. Rows behind a `Shown` wrapper mount
 * empty and render once their plugin's state arrives (a hold starts after the first render), so an Enter right after
 * typing can come before the text's rows exist: a command in Recent moves to its group as the reader types, and its
 * new row is not there yet.
 */
const waiting = new WeakMap<HTMLElement, { readonly query: string; readonly at: number }>();

/**
 * How long such an Enter waits for its rows: they usually render within a frame or two. Longer, it would act on an
 * Enter the reader gave up on (a query nothing matches, rows that arrive only after a reconnect).
 */
const ENTER_WAIT_MS = 1000;

/**
 * Clicks the highlighted option of `list` for an Enter on `query`; while there is none, the first option that renders
 * soon is clicked instead (`keepHighlight`), unless the text or page changed meanwhile.
 */
export function enter(list: HTMLElement, query: string): void {
	const option = highlighted(list);
	if (option) option.click();
	else waiting.set(list, { query, at: Date.now() });
}

/** Highlights `option` (a pointer moved over it), in the listbox it belongs to. */
export function highlight(option: HTMLElement): void {
	const list = option.closest<HTMLElement>('[role="listbox"]');
	if (!list) return;
	list.dataset.moved = "";
	select(list, option);
}

/** Highlights the first option of `list`, or none when it has none: the query or page changed, the reader starts over. */
export function highlightFirst(list: HTMLElement): void {
	delete list.dataset.moved;
	waiting.delete(list);
	select(list, list.querySelector<HTMLElement>(OPTION));
}

/** Keeps a highlight after rows came or went: the first option until the reader moved it, else when it is gone. */
export function keepHighlight(list: HTMLElement): void {
	if (list.dataset.moved === undefined) select(list, list.querySelector<HTMLElement>(OPTION));
	else if (!highlighted(list)) highlightFirst(list);
	const pending = waiting.get(list);
	const option = highlighted(list);
	if (!pending || !option) return;
	waiting.delete(list);
	if (inputOf(list)?.value === pending.query && Date.now() - pending.at < ENTER_WAIT_MS) option.click();
}

/** Moves the highlight `step` options down (up when negative), wrapping, and scrolls it into view. */
export function moveHighlight(list: HTMLElement, step: 1 | -1): void {
	const options = [...list.querySelectorAll<HTMLElement>(OPTION)];
	if (options.length === 0) return;
	const current = highlighted(list);
	const index = current ? options.indexOf(current) : step > 0 ? -1 : 0;
	const next = options[(index + step + options.length) % options.length]!;
	list.dataset.moved = "";
	select(list, next);
	next.scrollIntoView({ block: "nearest" });
}

function select(list: HTMLElement, option: HTMLElement | null): void {
	const current = highlighted(list);
	if (current === option) return;
	current?.removeAttribute("aria-selected");
	option?.setAttribute("aria-selected", "true");
	const input = inputOf(list);
	if (option) input?.setAttribute("aria-activedescendant", option.id);
	else input?.removeAttribute("aria-activedescendant");
}

/** The menu's input, which controls `list`. */
const inputOf = (list: HTMLElement): HTMLInputElement | null =>
	document.querySelector<HTMLInputElement>(`[aria-controls="${CSS.escape(list.id)}"]`);
