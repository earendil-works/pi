// "New" in My things: a person makes a thing of a kind people make (`creation: "person"`: a login, an inbox, an MCP
// server) for themselves, a group of theirs or (the owner) the Pi. A kind with a creation view (`ThingViews`'
// `Create`: a sign-in) runs its step inside this form and hands back the input its `create` hook takes; any other kind
// is made at once.

import { Button, Heading } from "@earendil-works/elanor-react";
import type { JsonValue, ThingKeeper } from "@earendil-works/p3/v1";
import { useRegistry } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import { ThingViews } from "./contract.web.tsx";
import { choiceName, type OwnerChoice, ownerKey } from "./give-thing.tsx";
import styles from "./session-things.module.css";
import { NameField } from "./thing-name.tsx";

/** What the form makes: a kind, its optional name, for whom, and the input its creation view collected (if any). */
export type MadeThing = {
	readonly kind: string;
	readonly name: string;
	readonly owner: ThingKeeper;
	readonly input: JsonValue | undefined;
};

/** The form over `kinds` and `owners` (those a thing may be made for); `onMake` makes it, `onCancel` closes. */
export function MakeThing(props: {
	readonly kinds: readonly { readonly kind: string; readonly title: string }[];
	readonly owners: readonly OwnerChoice[];
	readonly onMake: (made: MadeThing) => void;
	readonly onCancel: () => void;
	readonly action: Action;
}) {
	const views = useRegistry(ThingViews);
	const [kind, setKind] = useState<string | undefined>(undefined);
	const [owner, setOwner] = useState<string | undefined>(undefined);
	const [name, setName] = useState("");
	const keepers = props.owners.flatMap((choice) =>
		choice.owner.kind === "none" ? [] : [{ keeper: choice.owner, label: choiceName(choice) }],
	);
	const picked = props.kinds.find((each) => each.kind === kind) ?? props.kinds[0];
	const whom = keepers.find(({ keeper }) => ownerKey(keeper) === owner) ?? keepers[0];
	const Create = picked === undefined ? undefined : views?.get(picked.kind)?.value.Create;
	const make = (input: JsonValue | undefined) => {
		if (picked === undefined || whom === undefined) return;
		props.onMake({ kind: picked.kind, name: name.trim(), owner: whom.keeper, input });
	};
	return (
		<section aria-label="New thing" className={styles.makeThing} data-make-thing="">
			<Heading level={3} size={6}>
				New thing
			</Heading>
			{props.kinds.length === 0 ? (
				<p className={styles.note}>No kind of thing here is made by a person.</p>
			) : (
				<>
					<Choice
						items={props.kinds.map((each) => ({ value: each.kind, label: each.title }))}
						label="Kind"
						name="make-kind"
						onChange={setKind}
						value={picked?.kind ?? null}
					/>
					<Choice
						items={keepers.map(({ keeper, label }) => ({ value: ownerKey(keeper), label }))}
						label="For"
						name="make-owner"
						onChange={setOwner}
						value={whom === undefined ? null : ownerKey(whom.keeper)}
					/>
					<NameField onChange={setName} title={picked?.title} value={name} />
					{/* The kind's own step (a sign-in) runs here and hands back its input; keyed by the kind, it starts over. */}
					{Create === undefined ? null : <Create key={picked?.kind} onReady={(input) => make(input)} />}
				</>
			)}
			<div className={styles.give}>
				{Create === undefined && picked !== undefined ? (
					<Button data-make-save="" onClick={() => make(undefined)} pending={props.action.pending}>
						Make
					</Button>
				) : null}
				<Button hierarchy="tertiary" onClick={props.onCancel}>
					Cancel
				</Button>
			</div>
		</section>
	);
}
