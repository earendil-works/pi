// Whom a session follows, as the owner sees it at the foot of the session sheet: one quiet line ("Has your things",
// "Has Ada's things", "Has nobody's things") and "Change", a pick of whom (themselves, a member, nobody). A session that
// follows a party has, live, every thing that party keeps "in all my sessions" while it writes there. A change keeps
// what the session had from the old party (`Sessions.follow`'s `keep`): stopping to follow takes nothing away.

import { Button } from "@earendil-works/elanor-react";
import type { Party } from "@earendil-works/p3/v1";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./session-things.module.css";

/** A party the session may follow, with its name: the owner (`You`) and the session's members. */
export type FollowChoice = { readonly party: Party; readonly name: string };

/** The line for whom the session follows (`name`, "You" for the viewer), and its change to one of `choices`. */
export function FollowLine(props: {
	readonly follows: Party | null;
	readonly name: string;
	readonly choices: readonly FollowChoice[];
	readonly onFollow: (follows: Party | null) => void;
	readonly action: Action;
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string | undefined>(undefined);
	const items = [
		{ value: NOBODY, label: "Nobody" },
		...props.choices.map(({ party, name }) => ({ value: partyKey(party), label: name })),
	];
	const current = props.follows === null ? NOBODY : partyKey(props.follows);
	const chosen = items.find((item) => item.value === picked)?.value ?? current;
	return (
		<div className={styles.followLine} data-following={current}>
			<p className={styles.follows}>
				<span data-follows="">{hasLine(props.follows, props.name)}</span>
				{open ? null : (
					<Button data-follow-open="" density="compact" hierarchy="tertiary" onClick={() => setOpen(true)}>
						Change
					</Button>
				)}
			</p>
			{open ? (
				<span className={styles.give}>
					<Choice items={items} label="Has the things of" name="follows" onChange={setPicked} value={chosen} />
					<Button
						data-follow-save=""
						density="compact"
						onClick={() => {
							props.onFollow(chosen === NOBODY ? null : partyOf(chosen));
							setOpen(false);
						}}
						pending={props.action.pending}
					>
						Change
					</Button>
					<Button density="compact" hierarchy="tertiary" onClick={() => setOpen(false)}>
						Cancel
					</Button>
				</span>
			) : null}
		</div>
	);
}

/** The pick's value for nobody. */
const NOBODY = "nobody";

/** "Has your things", "Has Ada's things", "Has nobody's things". */
function hasLine(follows: Party | null, name: string): string {
	if (follows === null) return "Has nobody's things";
	return name === "You" ? "Has your things" : `Has ${name}'s things`;
}

/** How whom a session follows reads: "You" for the viewer `me`, else its name (`followsName`); nobody. */
export function followName(follows: Party | null, me: string, followsName: string): string {
	if (follows === null) return "Nobody";
	return follows.kind === "person" && follows.id === me ? "You" : followsName;
}

/** A party as a key: `person:<id>`, `group:<id>`. */
function partyKey(party: Party): string {
	return `${party.kind}:${party.id}`;
}

/** The party of a key `partyKey` wrote. */
function partyOf(key: string): Party {
	const colon = key.indexOf(":");
	// The pick's values are `partyKey`'s.
	return { kind: key.slice(0, colon) as Party["kind"], id: key.slice(colon + 1) };
}
