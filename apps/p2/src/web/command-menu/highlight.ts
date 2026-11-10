// The command menu's highlighted option, kept in the DOM rather than React state: `aria-selected="true"` on one
// `[role=option]` of the listbox and the input's `aria-activedescendant`. Moving it re-renders nothing, and the rows of
// pages and searches, which render on their own, need not report themselves. Until the reader moves it (a key, the
// pointer), the highlight is the first option, also when rows appear above it later (a `Shown` row, a page's data);
// the listbox's `data-moved` says that the reader moved it.

const OPTION = '[role="option"]';
const SELECTED = '[role="option"][aria-selected="true"]';

/** The highlighted option of `list`, if any. */
export const highlighted = (list: HTMLElement): HTMLElement | null => list.querySelector<HTMLElement>(SELECTED);

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
	select(list, list.querySelector<HTMLElement>(OPTION));
}

/** Keeps a highlight after rows came or went: the first option until the reader moved it, else when it is gone. */
export function keepHighlight(list: HTMLElement): void {
	if (list.dataset.moved === undefined) select(list, list.querySelector<HTMLElement>(OPTION));
	else if (!highlighted(list)) highlightFirst(list);
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
	const input = document.querySelector(`[aria-controls="${CSS.escape(list.id)}"]`);
	if (option) input?.setAttribute("aria-activedescendant", option.id);
	else input?.removeAttribute("aria-activedescendant");
}
