// A thing's name as people give it: the optional name of a thing being made (My things' "New"; empty shows its kind's
// title), and the field that renames a thing in place (a row's "Rename": Enter or Save renames, Escape or Cancel
// leaves it; an empty name goes back to the kind's title).

import { Button, Field, Input } from "@earendil-works/elanor-react";
import { useState } from "react";
import type { Action } from "./action.ts";
import styles from "./session-things.module.css";

/** A thing's name: at most 100 characters, as the sessions plugin takes it. */
const MAX_NAME = 100;

/** The optional name of a thing to make; `title` (its kind's) is what an empty name shows. */
export function NameField(props: {
	readonly value: string;
	readonly onChange: (name: string) => void;
	readonly title: string | undefined;
}) {
	return (
		<Field.Root className={styles.name}>
			<Field.Label>Name</Field.Label>
			<Input
				data-field="name"
				maxLength={MAX_NAME}
				onValueChange={props.onChange}
				placeholder={props.title ?? "Its kind's title"}
				value={props.value}
			/>
		</Field.Root>
	);
}

/** The rename field, starting at `name` (its placeholder the kind's `title`); `onDone` closes it either way. */
export function RenameField(props: {
	readonly name: string;
	readonly title: string;
	readonly onRename: (name: string) => void;
	readonly onDone: () => void;
	readonly action: Action;
}) {
	const [value, setValue] = useState(props.name);
	const save = () => {
		props.onRename(value.trim());
		props.onDone();
	};
	return (
		<span className={styles.give}>
			<Input
				aria-label="Name"
				autoFocus
				data-field="rename"
				maxLength={MAX_NAME}
				onKeyDown={(event) => {
					if (event.key === "Enter") save();
					if (event.key !== "Escape") return;
					// The dialog around closes on Escape too: this one only leaves the field.
					event.stopPropagation();
					props.onDone();
				}}
				onValueChange={setValue}
				placeholder={props.title}
				value={value}
			/>
			<Button data-rename-save="" density="compact" onClick={save} pending={props.action.pending}>
				Save
			</Button>
			<Button density="compact" hierarchy="tertiary" onClick={props.onDone}>
				Cancel
			</Button>
		</span>
	);
}
