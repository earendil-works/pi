// The options panel of one thing in `SessionThingsView` (a row's "Options", for whoever may set its options): a pick
// of whose options (everyone's, the agent's, a member's) and the thing's kind's own form (`ThingViews`' `Options`)
// over the options that party has now. A party without options of its own (the agent, a member) shows the default
// and saves its own; one with its own may go back to the default.

import { Button } from "@earendil-works/elanor-react";
import type { JsonValue, Member, OptionsFor } from "@earendil-works/p3/v1";
import { useRegistry } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import type { Action } from "./action.ts";
import { Choice } from "./choice.tsx";
import { ThingViews } from "./contract.web.tsx";
import styles from "./session-things.module.css";

/** A thing's options as `SessionInfo` gives them: the default, and the agent's and members' own. */
export type ThingOptionsOf = {
	readonly thing: string;
	readonly kind: string;
	readonly options: unknown;
	readonly overrides: readonly { readonly for: OptionsFor; readonly options: unknown }[];
};

/**
 * The panel: the pick and the kind's form; `onSave` sets options for a party (`null`: back to the default). Nothing
 * for a kind whose plugin offers no form.
 */
export function ThingOptionsPanel(props: {
	readonly session: string;
	readonly thing: ThingOptionsOf;
	readonly members: readonly (Member & { readonly name: string })[];
	readonly onSave: (forWhom: OptionsFor, options: JsonValue | null) => void;
	readonly action: Action;
}) {
	const Form = useRegistry(ThingViews)?.get(props.thing.kind)?.value.Options;
	const [whom, setWhom] = useState("everyone");
	if (Form === undefined) return null;
	const parties = [
		{ value: "everyone", label: "Everyone" },
		{ value: "agent", label: "The agent" },
		...props.members.map((member) => ({ value: `${member.kind}:${member.id}`, label: member.name })),
	];
	// A member removed while picked: back to everyone.
	const picked = parties.some((party) => party.value === whom) ? whom : "everyone";
	const forWhom = forOf(picked);
	const own = props.thing.overrides.find((override) => keyOf(override.for) === picked);
	// Options came from the server as the kind reads them (JSON), or `null`.
	const current = (picked === "everyone" ? props.thing.options : (own?.options ?? props.thing.options)) as JsonValue;
	return (
		<div className={styles.optionsPanel} data-thing-options={props.thing.thing}>
			<Choice items={parties} label="Whose" name="whose" onChange={setWhom} value={picked} />
			{picked === "everyone" ? null : (
				<p className={styles.note} data-options-source={own === undefined ? "default" : "own"}>
					{own === undefined ? "Uses the default." : "Their own options."}
					{own === undefined ? null : (
						<Button
							data-options-reset=""
							density="compact"
							hierarchy="tertiary"
							onClick={() => props.onSave(forWhom, null)}
							pending={props.action.pending}
						>
							Use the default
						</Button>
					)}
				</p>
			)}
			<Form
				for={forWhom}
				key={`${picked} ${JSON.stringify(current)}`}
				onSave={(target, options) => props.onSave(target, options)}
				options={current}
				session={props.session}
				thing={props.thing.thing}
			/>
		</div>
	);
}

/** A party's key in the pick: `everyone`, `agent`, `person:<id>`, `group:<id>`. */
function keyOf(party: OptionsFor): string {
	return party.kind === "everyone" || party.kind === "agent" ? party.kind : `${party.kind}:${party.id}`;
}

/** The party of a key in the pick (written by `keyOf` and the members' items). */
function forOf(key: string): OptionsFor {
	if (key === "everyone" || key === "agent") return { kind: key };
	const colon = key.indexOf(":");
	// The members' items are `person:<id>` and `group:<id>`.
	return { kind: key.slice(0, colon) as "person" | "group", id: key.slice(colon + 1) };
}
