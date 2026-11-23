// The view `MyThingsView`: the things a person manages outside sessions (their own, their groups', the Pi's for the
// owner; `MyThings`, one list per mounted view, found by the start of their name, the next page on request). Each
// shows its name and whose it is, and offers "In all my sessions" (every session that follows its owner has it),
// rename, give away, delete (after a second press) and where it is used. "New" makes a thing of a kind people make.

import { Button, Field, Input, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { type Context, Me, MyThings, type Reference, type Static, type TitledThing } from "@earendil-works/p3/v1";
import { useHold, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { type Action, useAction } from "./action.ts";
import { GiveThing, type OwnerChoice, ownerKey } from "./give-thing.tsx";
import { MakeThing } from "./make-thing.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";
import { ThingName } from "./thing-name.tsx";
import { ThingUsesList } from "./thing-uses.tsx";

/** The caller's things, with search, "New" and each one's actions. */
export function MyThingsList() {
	const [prefix, setPrefix] = useState("");
	const [making, setMaking] = useState(false);
	const mine = useVariant(useHold(MyThings, { view: useViewId(), prefix: prefix.trim() }), "mine");
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const list = useWatch(mine?.list);
	const kinds = useWatch(mine?.kinds) ?? [];
	const owners = useWatch(mine?.owners) ?? [];
	const action = useAction();
	const myId = me?.kind === "person" ? me.id : undefined;
	return (
		<div className={styles.things} data-my-things="">
			<div className={styles.give}>
				<Field.Root className={styles.name}>
					<Field.Label>Search</Field.Label>
					<Input data-field="search" onValueChange={setPrefix} placeholder="Name starts with…" value={prefix} />
				</Field.Root>
				{making ? null : (
					<Button data-make-open="" onClick={() => setMaking(true)}>
						New
					</Button>
				)}
			</div>
			{!making || mine === undefined ? null : (
				<MakeThing
					action={action}
					kinds={kinds}
					onCancel={() => setMaking(false)}
					onMake={({ kind, name, owner, input }) => {
						setMaking(false);
						action.run((ctx) =>
							mine.create(
								{ kind, owner, ...(name === "" ? {} : { name }), ...(input === undefined ? {} : { input }) },
								ctx,
							),
						);
					}}
					owners={owners}
				/>
			)}
			{list === undefined ? <p className={styles.note}>Loading…</p> : null}
			{list !== undefined && list.rows.length === 0 ? <p className={styles.note}>No things yet.</p> : null}
			<ul className={styles.items}>
				{(list?.rows ?? []).map((thing) => (
					<MyThing action={action} key={thing.id} me={myId} mine={mine} owners={owners} thing={thing} />
				))}
			</ul>
			{list?.moreAfter === true && mine !== undefined ? (
				<Button density="compact" hierarchy="tertiary" onClick={() => action.run((ctx) => mine.more(ctx))}>
					More
				</Button>
			) : null}
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</div>
	);
}

/** The caller's `MyThings`, as a row calls it. */
type Mine = Extract<Reference<typeof MyThings>, { readonly variant: "mine" }>;

/** One thing: its name (renamed in place), whose, its kind, its switch and its actions, and where it is used. */
function MyThing(props: {
	readonly thing: Static<typeof TitledThing>;
	readonly me: string | undefined;
	readonly mine: Mine | undefined;
	readonly owners: readonly OwnerChoice[];
	readonly action: Action;
}) {
	const { thing, mine, action } = props;
	const [uses, setUses] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const run = (call: (my: Mine, context: Context) => Promise<unknown>) => {
		if (mine !== undefined) action.run((ctx) => call(mine, ctx));
	};
	const owner = props.owners.find((choice) => ownerKey(choice.owner) === ownerKey(thing.owner))?.name;
	const whose =
		thing.owner.kind === "person" && thing.owner.id === props.me
			? "Yours"
			: thing.owner.kind === "pi"
				? "The Pi's"
				: `${owner ?? "Someone"}'s`;
	return (
		<li className={styles.myThing} data-my-thing={thing.id}>
			<div className={styles.grow}>
				<ThingName
					action={action}
					name={thing.name}
					rename={(name) => run((my, ctx) => my.rename({ thing: thing.id, name }, ctx))}
					title={thing.title}
				/>
				<span className={styles.whose} data-whose="">
					{whose}
				</span>
			</div>
			<SelectionControlAndLabel
				control={
					<Switch.Root
						checked={thing.everywhere}
						data-everywhere={thing.id}
						onCheckedChange={(everywhere) =>
							run((my, ctx) => my.setEverywhere({ thing: thing.id, everywhere }, ctx))
						}
					>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				In all my sessions
			</SelectionControlAndLabel>
			<div className={styles.rowActions}>
				<Button
					aria-expanded={uses}
					data-uses-open=""
					density="compact"
					hierarchy="tertiary"
					onClick={() => setUses(!uses)}
				>
					Used in
				</Button>
				<GiveThing
					action={action}
					current={thing.owner}
					label="Give away"
					onGive={(to) => run((my, ctx) => my.keep({ thing: thing.id, owner: to }, ctx))}
					owners={props.owners}
				/>
				{deleting ? (
					<>
						<Button
							data-delete-confirm=""
							density="compact"
							onClick={() => run((my, ctx) => my.delete({ thing: thing.id }, ctx))}
							semantic="negative"
						>
							Delete everywhere
						</Button>
						<Button density="compact" hierarchy="tertiary" onClick={() => setDeleting(false)}>
							Keep it
						</Button>
					</>
				) : (
					<Button
						data-delete-open=""
						density="compact"
						hierarchy="tertiary"
						onClick={() => setDeleting(true)}
						semantic="negative"
					>
						Delete
					</Button>
				)}
			</div>
			{uses ? (
				<ThingUsesList action={action} followers={followersOf(thing, props.me, owner)} thing={thing.id} />
			) : null}
		</li>
	);
}

/**
 * Whose following sessions have `thing` besides those that link it: for a thing "in all my sessions", its owner as
 * the reader `me` names them ("you", a person or group by `ownerName`, "the owner" for the Pi's); none otherwise.
 */
function followersOf(
	thing: Static<typeof TitledThing>,
	me: string | undefined,
	ownerName: string | undefined,
): string | undefined {
	if (!thing.everywhere) return undefined;
	switch (thing.owner.kind) {
		case "pi":
			return "the owner";
		case "person":
			return thing.owner.id === me ? "you" : (ownerName ?? "its owner");
		case "group":
			return ownerName ?? "its group";
		case "none":
			return undefined;
	}
}
