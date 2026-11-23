// Whom a session follows, as the owner sees and changes it in the session sheet: "Follows: you", a member, or nobody.
// A session that follows a party has, live, every thing that party keeps "in all my sessions" while it writes there.
// A change keeps what the session had from the old party (`Sessions.follow`'s `keep`): stopping to follow takes
// nothing away until someone removes it.

import { Button, Heading } from "@earendil-works/elanor-react";
import type { Party } from "@earendil-works/p3/v1";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import styles from "./session-things.module.css";

/** A party the session may follow, with its name: the owner (`you`) and the session's members. */
export type FollowChoice = { readonly party: Party; readonly name: string };

/** "Follows: <whom>" (`name`), and for `onFollow` (the owner) a pick of `choices` or nobody. */
export function Following(props: {
	readonly follows: Party | null;
	readonly name: string;
	readonly choices: readonly FollowChoice[];
	readonly onFollow: ((follows: Party | null) => void) | undefined;
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
		<section aria-label="Follows" className={styles.section} data-following={current}>
			<Heading level={3} size={6}>
				Follows
			</Heading>
			<p className={styles.follows}>
				<span data-follows="">{props.name}</span>
				{props.onFollow === undefined || open ? null : (
					<Button data-follow-open="" density="compact" hierarchy="tertiary" onClick={() => setOpen(true)}>
						Change
					</Button>
				)}
			</p>
			{props.onFollow === undefined || !open ? null : (
				<span className={styles.give}>
					<Choice items={items} label="Follow" name="follows" onChange={setPicked} value={chosen} />
					<Button
						data-follow-save=""
						density="compact"
						onClick={() => {
							props.onFollow?.(chosen === NOBODY ? null : partyOf(chosen));
							setOpen(false);
						}}
						pending={props.action.pending}
					>
						Follow
					</Button>
					<Button density="compact" hierarchy="tertiary" onClick={() => setOpen(false)}>
						Cancel
					</Button>
				</span>
			)}
			<p className={styles.note}>
				{props.follows === null
					? "It has only the things linked to it."
					: "It also has every thing they keep in all their sessions, while they write here."}
			</p>
		</section>
	);
}

/** The pick's value for nobody. */
const NOBODY = "nobody";

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
