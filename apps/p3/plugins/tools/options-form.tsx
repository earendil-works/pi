// The coding tools' options form (`ThingViews`' `Options`): one switch, "Shell" (bash offered or not), and its save.
// Shown by the session's view to whoever may set the tools' options, for the party they picked.

import { Button, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { CodingTools, type OptionsOf } from "@earendil-works/p3/v1";
import type { ThingOptionsProps } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./options-form.module.css";

/** The form over `props.options` (none readable: the kind's initial), saved for `props.for`. */
export function CodingToolsOptions(props: ThingOptionsProps) {
	// The options the sessions plugin gives a form are its kind's, checked against its schema when written.
	const stored = (props.options ?? CodingTools.initial) as OptionsOf<typeof CodingTools>;
	const [shell, setShell] = useState(stored.shell);
	return (
		<div className={styles.form} data-tools-options="">
			<SelectionControlAndLabel
				control={
					<Switch.Root checked={shell} data-option="shell" onCheckedChange={setShell}>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				Shell
			</SelectionControlAndLabel>
			<Button
				data-options-save=""
				disabled={shell === stored.shell}
				hierarchy="secondary"
				onClick={() => props.onSave(props.for, { shell })}
			>
				Save
			</Button>
		</div>
	);
}
