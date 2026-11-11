// The command menu's list parts, for the menu's own commands and for plugins' pages and searches: a group with its
// heading, and a row (an option of the listbox). Rows read no context, so typing re-renders only the lists that filter.
import { type ComponentType, type ReactNode, useId } from "react";
import { CheckIcon } from "../icons.tsx";
import { highlight } from "./highlight.ts";

/** A heading and its rows; hidden (by CSS) while it has no row. */
export function Group({ heading, children }: { heading: string; children: ReactNode }) {
	const id = useId();
	return (
		// biome-ignore lint/a11y/useSemanticElements: a listbox's groups are role="group" elements; a fieldset is a form's.
		<div className="command-group" role="group" aria-labelledby={id}>
			<div className="command-heading" id={id}>
				{heading}
			</div>
			{children}
		</div>
	);
}

/**
 * An option: icon, title, suffix (the provider beside a model), and a check on the current choice (`checked`). Enter
 * clicks the highlighted one, so `onSelect` runs for the pointer and the keyboard alike. The input keeps focus (the
 * menu's frame keeps it there).
 */
export function Row({
	title,
	icon: Icon,
	suffix,
	checked,
	onSelect,
}: {
	title: string;
	icon?: ComponentType;
	suffix?: ReactNode;
	/** The current choice among the page's rows (a model, a thinking level); absent where rows are no choice. */
	checked?: boolean;
	onSelect: () => void;
}) {
	const id = useId();
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the menu's input owns the keys (aria-activedescendant); Enter clicks the highlighted option.
		<div
			className="command-row"
			role="option"
			id={id}
			tabIndex={-1}
			aria-checked={checked}
			onClick={onSelect}
			// The mouse only: a finger's moves are scrolls and taps (a tap still selects).
			onPointerMove={(event) => event.pointerType === "mouse" && highlight(event.currentTarget)}
		>
			{/* Rows without an icon (a page of models) start at the inset, under their group's heading. */}
			{Icon && (
				<span className="command-icon">
					<Icon />
				</span>
			)}
			<span className="command-title">{title}</span>
			{(suffix !== undefined || checked) && (
				<span className="command-suffix">
					{suffix !== undefined && <span className="command-suffix-text">{suffix}</span>}
					{checked && <CheckIcon />}
				</span>
			)}
		</div>
	);
}
