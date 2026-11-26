// The view `MyThingsView`: the things a person manages outside sessions (their own, their groups', the Pi's for the
// owner; `MyThings`, one list per mounted view, the next page on request). One row per thing: its kind's icon, its
// name, its kind and whose it is, and the "In all my sessions" switch (every session that follows its owner has it);
// rename, give away, where it is used and delete (after a second press) behind the row's "⋯". "New" makes a thing of a
// kind people make (shown only when there is such a kind); the search by the start of a name shows once the list is
// long, else behind a small search button.

import { Button, Field, IconButton, Input, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { type Context, Me, MyThings, type Reference, type Static, type TitledThing } from "@earendil-works/p3/v1";
import { SearchIcon, useHold, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { type ReactNode, useState } from "react";
import { type Action, useAction } from "./action.ts";
import { GivePanel, keepersOf, type OwnerChoice, ownerKey } from "./give-thing.tsx";
import { MakeThing } from "./make-thing.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";
import { RenameField } from "./thing-name.tsx";
import { type RowAction, ThingRow } from "./thing-row.tsx";
import { ThingUsesList } from "./thing-uses.tsx";

/** How many things a list shows before its search shows by itself. */
const SEARCH_FROM = 10;

/** The caller's things, with "New", the search and each one's row. */
export function MyThingsList() {
	const [prefix, setPrefix] = useState("");
	const [searching, setSearching] = useState(false);
	const [making, setMaking] = useState(false);
	const mine = useVariant(useHold(MyThings, { view: useViewId(), prefix: prefix.trim() }), "mine");
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const list = useWatch(mine?.list);
	const kinds = useWatch(mine?.kinds) ?? [];
	const owners = useWatch(mine?.owners) ?? [];
	const action = useAction();
	const myId = me?.kind === "person" ? me.id : undefined;
	const long = (list?.rows.length ?? 0) > SEARCH_FROM || list?.moreAfter === true;
	const search = long || searching || prefix !== "";
	return (
		<div className={styles.things} data-my-things="">
			<div className={styles.give}>
				{search ? (
					<Field.Root className={styles.name}>
						<Field.Label>Search</Field.Label>
						<Input
							autoFocus={searching}
							data-field="search"
							onValueChange={setPrefix}
							placeholder="Name starts with…"
							value={prefix}
						/>
					</Field.Root>
				) : (
					<IconButton aria-label="Search" data-search-open="" onClick={() => setSearching(true)}>
						<SearchIcon />
					</IconButton>
				)}
				{making || kinds.length === 0 ? null : (
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

/** What a row's action opened under it. */
type Panel = "rename" | "give" | "uses" | "delete";

/** One thing: its row with its switch and its menu, and the panel an action opened. */
function MyThing(props: {
	readonly thing: Static<typeof TitledThing>;
	readonly me: string | undefined;
	readonly mine: Mine | undefined;
	readonly owners: readonly OwnerChoice[];
	readonly action: Action;
}) {
	const { thing, mine, action } = props;
	const [panel, setPanel] = useState<Panel | undefined>(undefined);
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
	const close = () => setPanel(undefined);
	const actions: RowAction[] = [
		{ key: "rename", label: "Rename", run: () => setPanel("rename") },
		...(keepersOf(props.owners, thing.owner).length > 0
			? [{ key: "give", label: "Give away", run: () => setPanel("give") }]
			: []),
		{ key: "uses", label: "Used in", run: () => setPanel(panel === "uses" ? undefined : "uses") },
		{ key: "delete", label: "Delete", run: () => setPanel("delete") },
	];
	const panels: Readonly<Record<Panel, () => ReactNode>> = {
		rename: () => (
			<RenameField
				action={action}
				name={thing.name}
				onDone={close}
				onRename={(name) => run((my, ctx) => my.rename({ thing: thing.id, name }, ctx))}
				title={thing.title}
			/>
		),
		give: () => (
			<GivePanel
				action={action}
				current={thing.owner}
				label="Give away"
				onDone={close}
				onGive={(to) => run((my, ctx) => my.keep({ thing: thing.id, owner: to }, ctx))}
				owners={props.owners}
			/>
		),
		uses: () => <ThingUsesList action={action} followers={followersOf(thing, props.me, owner)} thing={thing.id} />,
		delete: () => (
			<span className={styles.give}>
				<Button
					data-delete-confirm=""
					density="compact"
					onClick={() => run((my, ctx) => my.delete({ thing: thing.id }, ctx))}
					semantic="negative"
				>
					Delete everywhere
				</Button>
				<Button density="compact" hierarchy="tertiary" onClick={close}>
					Keep it
				</Button>
			</span>
		),
	};
	return (
		<ThingRow
			actions={actions}
			beside={
				<SelectionControlAndLabel
					className={styles.everywhere}
					control={
						<Switch.Root
							aria-label="In all my sessions"
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
					<span className={styles.everywhereLabel}>In all my sessions</span>
				</SelectionControlAndLabel>
			}
			data={{ "data-my-thing": thing.id }}
			kind={thing.kind}
			line={`${thing.title} · ${whose}`}
			name={thing.name === "" ? thing.title : thing.name}
			onOpen={undefined}
			panel={panel === undefined ? null : panels[panel]()}
		/>
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
