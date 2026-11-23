// Giving a thing an owner, as the session sheet ("Keep": a session's content to me, a group of mine, or the Pi for the
// owner) and My things ("Give away") offer it from a row's menu: a pick of whom (the caller's `owners`, nobody left
// out: a thing is never given back to nobody) and the button that gives it.

import { Button } from "@earendil-works/elanor-react";
import type { ThingKeeper, ThingOwner } from "@earendil-works/p3/v1";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./session-things.module.css";

/** Whom the caller may give a thing, with a name to show (`SessionThings.owners`, `MyThings.owners`). */
export type OwnerChoice = { readonly owner: ThingOwner; readonly name: string };

/** Whom a thing owned by `current` may be given among `owners`: everyone there but nobody and its owner now. */
export function keepersOf(
	owners: readonly OwnerChoice[],
	current: ThingOwner,
): { keeper: ThingKeeper; name: string }[] {
	return owners.flatMap((choice) => {
		const { owner } = choice;
		return owner.kind === "none" || ownerKey(owner) === ownerKey(current)
			? []
			: [{ keeper: owner, name: choiceName(choice) }];
	});
}

/** The pick of whom (`keepersOf`) and `label` ("Keep", "Give away"), which gives it; `onDone` closes it either way. */
export function GivePanel(props: {
	readonly label: string;
	readonly owners: readonly OwnerChoice[];
	readonly current: ThingOwner;
	readonly onGive: (owner: ThingKeeper) => void;
	readonly onDone: () => void;
	readonly action: Action;
}) {
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const keepers = keepersOf(props.owners, props.current);
	const chosen = keepers.find(({ keeper }) => ownerKey(keeper) === picked) ?? keepers[0];
	if (chosen === undefined) return null;
	return (
		<span className={styles.give} data-give="">
			<Choice
				items={keepers.map(({ keeper, name }) => ({ value: ownerKey(keeper), label: name }))}
				label="To"
				name="keeper"
				onChange={setPicked}
				value={ownerKey(chosen.keeper)}
			/>
			<Button
				data-give-save=""
				density="compact"
				onClick={() => {
					props.onGive(chosen.keeper);
					props.onDone();
				}}
				pending={props.action.pending}
			>
				{props.label}
			</Button>
			<Button density="compact" hierarchy="tertiary" onClick={props.onDone}>
				Cancel
			</Button>
		</span>
	);
}

/** How a choice of owner reads: its name; the Pi, whose name the server leaves empty, as "The Pi". */
export function choiceName(choice: OwnerChoice): string {
	return choice.owner.kind === "pi" && choice.name === "" ? "The Pi" : choice.name;
}

/** An owner as a key: `pi`, `none`, `person:<id>`, `group:<id>`. */
export function ownerKey(owner: ThingOwner): string {
	return owner.kind === "person" || owner.kind === "group" ? `${owner.kind}:${owner.id}` : owner.kind;
}
