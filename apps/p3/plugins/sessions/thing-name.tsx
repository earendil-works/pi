// A thing's name in `SessionThingsView`: the optional name field of "Add a thing" and "Bring your own" (empty shows
// the kind's title), and a thing's name as its row shows it (its kind's title as a small label beside a name), renamed
// in place by whoever may (the owner any thing, a person what they brought).

import { Button, Field, Input } from "@earendil-works/elanor-react";
import { useState } from "react";
import type { Action } from "./action.ts";
import styles from "./session-things.module.css";

/** A thing's name: at most 100 characters, as the sessions plugin takes it. */
const MAX_NAME = 100;

/** The optional name of a thing to add; `title` (its kind's) is what an empty name shows. */
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

/**
 * A thing's name (else its kind's title), with the kind's title (when known) as a small label when it has a name; with
 * `rename`, a "Rename" button turns it into a field (Enter or Save renames, Escape or Cancel leaves it; an empty name
 * goes back to the kind's title).
 */
export function ThingName(props: {
	readonly name: string;
	readonly title: string;
	readonly rename: ((name: string) => void) | undefined;
	readonly action: Action;
}) {
	const [editing, setEditing] = useState<string | undefined>(undefined);
	if (editing !== undefined && props.rename !== undefined) {
		const rename = props.rename;
		const save = () => {
			rename(editing.trim());
			setEditing(undefined);
		};
		return (
			<span className={styles.renaming}>
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
						setEditing(undefined);
					}}
					onValueChange={setEditing}
					placeholder={props.title}
					value={editing}
				/>
				<Button data-rename-save="" density="compact" onClick={save} pending={props.action.pending}>
					Save
				</Button>
				<Button density="compact" hierarchy="tertiary" onClick={() => setEditing(undefined)}>
					Cancel
				</Button>
			</span>
		);
	}
	return (
		<span className={styles.named}>
			<span className={styles.title} data-thing-name="">
				{props.name === "" ? props.title : props.name}
			</span>
			{props.name === "" || props.title === "" ? null : (
				<span className={styles.kind} data-thing-kind="">
					{props.title}
				</span>
			)}
			{props.rename === undefined ? null : (
				<Button
					className={styles.renameButton}
					data-rename-open=""
					density="compact"
					hierarchy="tertiary"
					onClick={() => setEditing(props.name)}
				>
					Rename
				</Button>
			)}
		</span>
	);
}
