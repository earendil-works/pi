// The board kind's options form (`ThingViews`' `Options`): one switch, "May draw", and its save. Shown by the
// session's view to whoever may set a board's options, for the party they picked.

import { Button, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import type { OptionsOf } from "@earendil-works/p3/v1";
import type { ThingOptionsProps } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./board-view.module.css";
import { CanvasKind } from "./contract.ts";

/** The form over `props.options` (none readable: the kind's initial), saved for `props.for`. */
export function CanvasOptions(props: ThingOptionsProps) {
	// The options the sessions plugin gives a form are its kind's, checked against its schema when written.
	const stored = (props.options ?? CanvasKind.initial) as OptionsOf<typeof CanvasKind>;
	const [draw, setDraw] = useState(stored.draw);
	return (
		<div className={styles.options} data-canvas-options="">
			<SelectionControlAndLabel
				control={
					<Switch.Root checked={draw} data-option="draw" onCheckedChange={setDraw}>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				May draw
			</SelectionControlAndLabel>
			<Button
				data-options-save=""
				disabled={draw === stored.draw}
				hierarchy="secondary"
				onClick={() => props.onSave(props.for, { draw })}
			>
				Save
			</Button>
		</div>
	);
}
