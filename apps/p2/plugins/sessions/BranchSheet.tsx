// The owner's sheet for a `/tree` branch's label (docs/tree.md): a new label, or for conversation 1 the session title.
import { Sheet } from "@p2/app/v1/web";
import { useState } from "react";
import { PREVIEW_LENGTH } from "../tree/contract.ts";

/** Renames a branch; `label` null shows `title` (conversation 1's default), and only conversation 1 may go back to it. */
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
	onSave: (label: string | null) => Promise<unknown>;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(label ?? title);
	const [error, setError] = useState<string>();
	const next = draft.replace(/\s+/g, " ").trim();
	const resettable = conversation === 1;
	const unchanged = next === (label ?? title);
	const save = (value: string | null) =>
		void onSave(value)
			.then(onClose)
			.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
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
						className="input"
						value={draft}
						maxLength={PREVIEW_LENGTH}
						onChange={(event) => setDraft(event.target.value)}
					/>
				</label>
				{resettable && (
					<p className="muted small">The first branch shows the session title until it gets a label of its own.</p>
				)}
				{error && <p className="error small">{error}</p>}
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
