// The command menu's header: the target chip with the open pages' crumbs, and the input, which owns the menu's keys.
import type { KeyboardEvent, Ref } from "react";
import { CommandPages, useRegistry } from "../../runtime/web.tsx";
import { ChevronIcon, CloseIcon } from "../icons.tsx";
import { useCommandMenuValue } from "./context.ts";
import { highlighted, moveHighlight } from "./highlight.ts";

/**
 * The target chip, its kind then its label ("Session · Fix the build"; Backspace or its × removes it), and a crumb per
 * open page, on one line: a long label ellipsizes, the kind and the crumbs stay whole. Nothing at a root without a
 * target.
 */
export function Target() {
	const { state, actions } = useCommandMenuValue();
	const pages = useRegistry(CommandPages);
	const { target } = state;
	if (target === undefined && state.pages.length === 0) return null;
	return (
		<div className="command-context">
			{target && (
				<span className="command-chip">
					{/* The full text as a tooltip: a long label ellipsizes. The space before the label is for the text's
					    reading order; the gap shows it. */}
					<span
						className="command-chip-text"
						title={target.label === "" ? target.kind : `${target.kind} · ${target.label}`}
					>
						<span className="command-chip-kind">{target.label === "" ? target.kind : `${target.kind} ·`}</span>
						{target.label !== "" && <span className="command-chip-label"> {target.label}</span>}
					</span>
					<button
						type="button"
						className="command-chip-remove"
						aria-label="Remove target"
						tabIndex={-1}
						onClick={actions.removeTarget}
					>
						<CloseIcon />
					</button>
				</span>
			)}
			{state.pages.map((name, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a crumb is its place in the page stack.
				<span key={index} className="command-crumb">
					<ChevronIcon size={12} />
					{(name === undefined ? undefined : pages.get(name)?.label) ?? "Page"}
				</span>
			))}
		</div>
	);
}

const ROOT_PLACEHOLDER = "Type a command or search…";

/**
 * The input, controlled by the dialog (`query` is the open page's, at once). Up/Down move the highlight, Enter clicks
 * it (after the list caught up with the input), Escape closes, Backspace on an empty input goes up a page or removes the target, Tab stays here.
 */
export function Input({
	ref,
	query,
	onQuery,
}: {
	ref: Ref<HTMLInputElement>;
	query: string;
	onQuery: (query: string) => void;
}) {
	const { state, actions, meta } = useCommandMenuValue();
	const pages = useRegistry(CommandPages);
	const name = state.pages.at(-1);
	const placeholder =
		state.pages.length === 0
			? ROOT_PLACEHOLDER
			: ((name === undefined ? undefined : pages.get(name)?.placeholder) ?? "Search…");
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		const list = meta.list.current;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp":
				event.preventDefault();
				if (list) moveHighlight(list, event.key === "ArrowDown" ? 1 : -1);
				return;
			case "Enter":
				event.preventDefault();
				// The list may still show the previous query's rows (it filters on the deferred one).
				if (query !== state.query) meta.settle(query);
				if (list) highlighted(list)?.click();
				return;
			case "Escape":
				event.preventDefault();
				void actions.close();
				return;
			case "Tab":
				event.preventDefault();
				return;
			case "Backspace":
				if (query !== "") return;
				if (state.pages.length > 0) actions.back();
				else if (state.target) actions.removeTarget();
				else return;
				event.preventDefault();
		}
	};
	return (
		<label className="command-input">
			<input
				ref={ref}
				role="combobox"
				aria-label="Command menu"
				aria-expanded="true"
				aria-controls={meta.listId}
				aria-autocomplete="list"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				enterKeyHint="go"
				placeholder={placeholder}
				value={query}
				onChange={(event) => onQuery(event.currentTarget.value)}
				onKeyDown={onKeyDown}
			/>
		</label>
	);
}
