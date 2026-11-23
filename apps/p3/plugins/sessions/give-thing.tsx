// Giving a thing an owner, as the session sheet ("Keep": a session's content to me, a group of mine, or the Pi for the
// owner) and My things ("Give away") offer it: a button that opens a pick of whom (the caller's `owners`, nobody left
// out: a thing is never given back to nobody) and the button that gives it.

import { Button } from "@earendil-works/elanor-react";
import type { ThingKeeper, ThingOwner } from "@earendil-works/p3/v1";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./session-things.module.css";

/** Whom the caller may give a thing, with a name to show (`SessionThings.owners`, `MyThings.owners`). */
export type OwnerChoice = { readonly owner: ThingOwner; readonly name: string };

/**
 * `label` ("Keep", "Give away"), opening the pick of `owners` (those a thing may be given) without `current` (the
 * thing's owner now); `onGive` gets the one picked.
 */
export function GiveThing(props: {
	readonly label: string;
	readonly owners: readonly OwnerChoice[];
	readonly current: ThingOwner;
	readonly onGive: (owner: ThingKeeper) => void;
	readonly action: Action;
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const keepers = props.owners.flatMap(({ owner, name }) => {
		const keeper = keeperOf(owner);
		return keeper === undefined || ownerKey(owner) === ownerKey(props.current) ? [] : [{ keeper, name }];
	});
	if (keepers.length === 0) return null;
	if (!open) {
		return (
			<Button data-give-open="" density="compact" hierarchy="tertiary" onClick={() => setOpen(true)}>
				{props.label}
			</Button>
		);
	}
	const items = keepers.map(({ keeper, name }) => ({ value: ownerKey(keeper), label: name }));
	const chosen = keepers.find(({ keeper }) => ownerKey(keeper) === picked) ?? keepers[0]!;
	return (
		<span className={styles.give} data-give="">
			<Choice items={items} label="To" name="keeper" onChange={setPicked} value={ownerKey(chosen.keeper)} />
			<Button
				data-give-save=""
				density="compact"
				onClick={() => {
					props.onGive(chosen.keeper);
					setOpen(false);
				}}
				pending={props.action.pending}
			>
				{props.label}
			</Button>
			<Button density="compact" hierarchy="tertiary" onClick={() => setOpen(false)}>
				Cancel
			</Button>
		</span>
	);
}

/** An owner as a key: `pi`, `none`, `person:<id>`, `group:<id>`. */
export function ownerKey(owner: ThingOwner): string {
	return owner.kind === "person" || owner.kind === "group" ? `${owner.kind}:${owner.id}` : owner.kind;
}

/** `owner` as someone a thing may be given (`undefined` for nobody). */
function keeperOf(owner: ThingOwner): ThingKeeper | undefined {
	return owner.kind === "none" ? undefined : owner;
}
