// The owner's sheet for a `/tree` branch's label (docs/tree.md): a new label, or for conversation 1 the session title.
// A route layer, opened from the branch row's command menu ("Rename branch…").
import { compile, int, str, tuple } from "@earendil-works/pi-schema";
import { type CommandTarget, type Layer, Sheet } from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { PREVIEW_LENGTH } from "../tree/contract.ts";

/** A branch of a session, as a branch row's command target and the sheet's locator name it. */
export type BranchRef = { readonly session: string; readonly conversation: number };

/** The name of the sheet's layer. */
export const BRANCH_SHEET = "branch-name";

/** Branch `conversation` of `session` as the command menu's target: "Rename branch…" acts on it. */
export const branchTarget = (ref: BranchRef, label: string): CommandTarget => ({
	type: "branch",
	id: JSON.stringify([ref.session, ref.conversation]),
	kind: "Branch",
	label,
});

/** The sheet's layer for a branch target's `id`. */
export const branchSheetLayer = (id: string): Layer => ({ kind: "sheet", name: BRANCH_SHEET, locator: id });

const isBranchId = compile(tuple([str(), int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })])).check;

/** The branch a target's id or the sheet's locator names; undefined for anything else (locators come from the URL). */
export function branchOf(text: string | undefined): BranchRef | undefined {
	try {
		const value: unknown = JSON.parse(text ?? "");
		if (!isBranchId(value)) return undefined;
		const [session, conversation] = value;
		return { session, conversation };
	} catch {
		return undefined;
	}
}

/**
 * Renames a branch; `label` null shows `title` (conversation 1's default), and only conversation 1 may go back to it.
 * Saving closes the sheet: the row shows the new label while the rename is in flight.
 */
export function BranchSheet({
	title,
	conversation,
	label,
	onSave,
	onClose,
}: {
	/** The session title, what a null label shows. */
	title: string;
	conversation: number;
	label: string | null;
	onSave: (label: string | null) => void;
	onClose: () => void;
}) {
	const shown = label ?? title;
	const [draft, setDraft] = useState(shown);
	// The field is what the sheet is for: focused, its text selected, so typing replaces it.
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const next = draft.replace(/\s+/g, " ").trim();
	const resettable = conversation === 1;
	const unchanged = next === shown;
	const save = (value: string | null) => {
		onSave(value);
		onClose();
	};
	return (
		<Sheet title="Branch name" onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (!unchanged && (next || resettable)) save(next || null);
				}}
			>
				<label className="field">
					<span className="label">Label in the sidebar and /tree</span>
					<input
						ref={field}
						className="input"
						value={draft}
						maxLength={PREVIEW_LENGTH}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</label>
				{resettable && (
					<p className="muted small">The first branch shows the session title until it gets a label of its own.</p>
				)}
				<div className="inline-form">
					<button type="submit" className="button" disabled={unchanged || (!next && !resettable)}>
						Save
					</button>
					{resettable && label !== null && (
						<button type="button" className="text-action" onClick={() => save(null)}>
							Use the session title
						</button>
					)}
				</div>
			</form>
		</Sheet>
	);
}
