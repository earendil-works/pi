// The notes kind's options form (`ThingViews`' `Options`): one switch, "May edit", and its save. Shown by the
// session's view to whoever may set a notebook's options, for the party they picked.

import { Button, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import type { OptionsOf } from "@earendil-works/p3/v1";
import type { ThingOptionsProps } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { NotesKind } from "./contract.ts";
import styles from "./notes-view.module.css";

/** The form over `props.options` (none readable: the kind's initial), saved for `props.for`. */
export function NotesOptions(props: ThingOptionsProps) {
	// The options the sessions plugin gives a form are its kind's, checked against its schema when written.
	const stored = (props.options ?? NotesKind.initial) as OptionsOf<typeof NotesKind>;
	const [edit, setEdit] = useState(stored.edit);
	return (
		<div className={styles.form} data-notes-options="">
			<SelectionControlAndLabel
				control={
					<Switch.Root checked={edit} data-option="edit" onCheckedChange={setEdit}>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				May edit
			</SelectionControlAndLabel>
			<Button
				data-options-save=""
				disabled={edit === stored.edit}
				hierarchy="secondary"
				onClick={() => props.onSave(props.for, { edit })}
			>
				Save
			</Button>
		</div>
	);
}
