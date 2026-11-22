// The view `SessionThingsView`: what a session holds, opened on demand. Everyone with access sees its location, its
// things (each in its kind's view, `<ThingView>`, with who brought it) and its members. A writer (a person or the
// owner) brings their own records (`BringThings`) and withdraws what they brought; the owner also adds and removes any
// thing (the kinds without records of `ThingKindCatalog`) and members (the persons of `PeopleList`), through
// `Sessions`.

import { Button, Heading } from "@earendil-works/elanor-react";
import {
	type Access,
	type Bringer,
	BringThings,
	type Context,
	Me,
	type Member,
	PeopleList,
	SessionInfo,
	type SessionRow,
	Sessions,
	type SessionThing,
	ThingKindCatalog,
} from "@earendil-works/p3/v1";
import { useHold, useRefState, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { type Action, useAction } from "./action.ts";
import { BringOwn, broughtKey, useBringable } from "./bring-own.tsx";
import { Choice } from "./choice.tsx";
import { ThingView } from "./contract.web.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";

/** Who the viewer is, as `Me` answers. */
type Viewer = { readonly kind: "owner" } | { readonly kind: "person"; readonly id: string; readonly name: string };

/** A thing as the view shows it: its id, kind and who brought it. */
type ShownThing = Pick<SessionThing, "thing" | "kind" | "ref" | "by"> & { readonly title: string };

/** A member as the view shows it: who, their access and their name. */
type ShownMember = Member & { readonly name: string };

/** Session `session`'s things and members; writers bring their own, the owner manages them. */
export function SessionThings(props: { readonly session: string }) {
	const infoRef = useHold(SessionInfo, { session: props.session });
	const info = useVariant(infoRef, "info");
	const state = useRefState(infoRef);
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const row = useWatch(info?.session);
	const access = useWatch(info?.access);
	const things = useWatch(info?.things);
	const members = useWatch(info?.members);
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You have no access to this session.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This session cannot be shown now.</p>;
	}
	if (row === undefined || access === undefined || things === undefined || members === undefined || me === undefined) {
		return <p className={styles.note}>Loading…</p>;
	}
	if (me.kind === "owner") return <Managed members={members} row={row} things={things} />;
	return <Working access={access} me={me} members={members} row={row} things={things} />;
}

/** A person's view: the lists, and for a writer their own things to bring and withdraw. */
function Working(props: {
	readonly row: SessionRow;
	readonly access: Access;
	readonly things: readonly ShownThing[];
	readonly members: readonly ShownMember[];
	readonly me: Viewer;
}) {
	const session = props.row.id;
	const bring = useVariant(useHold(BringThings, { session }), "writer");
	const bringable = useBringable(bring?.kinds);
	const change = useAction();
	const mine = (by: Bringer) => props.me.kind === "person" && by.kind === "person" && by.id === props.me.id;
	return (
		<div className={styles.things} data-session-things="">
			<Location row={props.row} />
			<Things
				removal={(thing) =>
					bring === undefined || !mine(thing.by)
						? undefined
						: { label: "Withdraw", run: () => change.run((ctx) => bring.withdraw({ thing: thing.thing }, ctx)) }
				}
				session={session}
				things={props.things}
				whose={(by) => whose(by, props.me, props.members)}
			/>
			{bring === undefined || bringable.kinds === undefined ? null : (
				<BringOwn
					action={change}
					brought={broughtBy(props.things, mine)}
					kinds={bringable.kinds}
					onBring={(kind, ref) => change.run((ctx) => bring.bring({ kind, ref }, ctx))}
				/>
			)}
			<Members members={props.members} me={props.me} />
			<Failures errors={[change.error, bringable.error]} />
		</div>
	);
}

/** The owner's view: the lists with their removals, what they bring, and the forms that add a thing and a member. */
function Managed(props: {
	readonly row: SessionRow;
	readonly things: readonly ShownThing[];
	readonly members: readonly ShownMember[];
}) {
	const session = props.row.id;
	const sessions = useVariant(useHold(Sessions, {}), "owner");
	const bring = useVariant(useHold(BringThings, { session }), "writer");
	const bringable = useBringable(bring?.kinds);
	const kinds = useWatch(useVariant(useHold(ThingKindCatalog, {}), "owner")?.kinds) ?? [];
	const peopleRef = useVariant(useHold(PeopleList, { view: useViewId() }), "owner");
	const people = useWatch(peopleRef?.list);
	const change = useAction();
	const manage = (call: (owner: NonNullable<typeof sessions>, context: Context) => Promise<unknown>) => {
		if (sessions !== undefined) change.run((ctx) => call(sessions, ctx));
	};
	return (
		<div className={styles.things} data-session-things="">
			<Location row={props.row} />
			<Things
				removal={(thing) => ({
					label: "Remove",
					run: () => manage((owner, ctx) => owner.removeThing({ session, thing: thing.thing }, ctx)),
				})}
				session={session}
				things={props.things}
				whose={(by) => whose(by, OWNER, props.members)}
			/>
			<AddThing
				action={change}
				kinds={kinds.map((kind) => ({ value: kind.kind, label: kind.title }))}
				onAdd={(kind) => manage((owner, ctx) => owner.addThing({ session, thing: { kind } }, ctx))}
			/>
			{bring === undefined || bringable.kinds === undefined ? null : (
				<BringOwn
					action={change}
					brought={broughtBy(props.things, (by) => by.kind === "owner")}
					kinds={bringable.kinds}
					onBring={(kind, ref) => change.run((ctx) => bring.bring({ kind, ref }, ctx))}
				/>
			)}
			<Members
				members={props.members}
				me={OWNER}
				onRemove={(party) => manage((owner, ctx) => owner.removeMember({ session, party }, ctx))}
			/>
			<AddMember
				action={change}
				more={
					peopleRef !== undefined && people?.moreAfter === true
						? () => change.run((ctx) => peopleRef.more(ctx))
						: undefined
				}
				onAdd={(member) => manage((owner, ctx) => owner.addMember({ session, member }, ctx))}
				persons={(people?.rows ?? []).map((person) => ({ value: person.id, label: person.name }))}
			/>
			<Failures errors={[change.error, bringable.error]} />
		</div>
	);
}

/** The owner, as a viewer. */
const OWNER: Viewer = { kind: "owner" };

/** The records among `things` that someone `theirs` says brought, as `BringOwn` tells them apart. */
function broughtBy(things: readonly ShownThing[], theirs: (by: Bringer) => boolean): ReadonlySet<string> {
	return new Set(things.filter((thing) => theirs(thing.by)).map((thing) => broughtKey(thing.kind, thing.ref)));
}

/**
 * Whose a thing is, as the viewer `me` reads it: yours, the owner's, the app's, or a person's by their name among
 * `members` (one no longer a member: a member's).
 */
function whose(by: Bringer, me: Viewer, members: readonly ShownMember[]): string {
	switch (by.kind) {
		case "owner":
			return me.kind === "owner" ? "Yours" : "The owner's";
		case "app":
			return "The app's";
		case "person": {
			if (me.kind === "person" && me.id === by.id) return "Yours";
			const name = members.find((member) => member.kind === "person" && member.id === by.id)?.name;
			return name === undefined ? "A member's" : `${name}'s`;
		}
	}
}

/** The failures of the view's actions, one line each. */
function Failures(props: { readonly errors: readonly (string | undefined)[] }) {
	return props.errors.map((error) =>
		error === undefined ? null : (
			<p className={styles.error} key={error}>
				{error}
			</p>
		),
	);
}

/** Where the session works. */
function Location(props: { readonly row: SessionRow }) {
	return (
		<p className={styles.location} data-location="">
			{props.row.location.environment}: {props.row.location.folder}
		</p>
	);
}

/**
 * The session's things, each in its kind's view (its kind's title while no plugin shows it) with whose it is, and the
 * removal `removal` offers for it (none: `undefined`).
 */
function Things(props: {
	readonly session: string;
	readonly things: readonly ShownThing[];
	readonly whose: (by: Bringer) => string;
	readonly removal: (thing: ShownThing) => { readonly label: string; readonly run: () => void } | undefined;
}) {
	return (
		<section aria-label="Things" className={styles.section}>
			<Heading level={3} size={6}>
				Things
			</Heading>
			{props.things.length === 0 ? <p className={styles.note}>None.</p> : null}
			<ul className={styles.items}>
				{props.things.map((thing) => {
					const removal = props.removal(thing);
					return (
						<li
							className={styles.item}
							data-by={thing.by.kind === "person" ? `person:${thing.by.id}` : thing.by.kind}
							data-thing={thing.kind}
							key={thing.thing}
						>
							<div className={styles.grow}>
								<ThingView
									fallback={<span>{thing.title}</span>}
									kind={thing.kind}
									session={props.session}
									thing={thing.thing}
								/>
								<span className={styles.whose}>{props.whose(thing.by)}</span>
							</div>
							{removal === undefined ? null : (
								<Button density="compact" hierarchy="tertiary" onClick={removal.run} semantic="negative">
									{removal.label}
								</Button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** The owner's pick of a kind of thing to add. */
function AddThing(props: {
	readonly kinds: readonly { readonly value: string; readonly label: string }[];
	readonly onAdd: (kind: string) => void;
	readonly action: Action;
}) {
	const [kind, setKind] = useState<string | undefined>(undefined);
	const picked = kind ?? props.kinds[0]?.value;
	if (props.kinds.length === 0) return null;
	return (
		<div className={styles.add} data-add-thing="">
			<Choice items={props.kinds} label="Add a thing" name="kind" onChange={setKind} value={picked ?? null} />
			<Button
				disabled={picked === undefined}
				onClick={() => picked !== undefined && props.onAdd(picked)}
				pending={props.action.pending}
			>
				Add
			</Button>
		</div>
	);
}

/** The session's members: who, and whether they read or write; `onRemove` if managed. */
function Members(props: {
	readonly members: readonly ShownMember[];
	readonly me: Viewer;
	readonly onRemove?: (party: { readonly kind: Member["kind"]; readonly id: string }) => void;
}) {
	return (
		<section aria-label="Members" className={styles.section}>
			<Heading level={3} size={6}>
				Members
			</Heading>
			{props.members.length === 0 ? <p className={styles.note}>Only the owner.</p> : null}
			<ul className={styles.items}>
				{props.members.map((member) => (
					<li className={styles.item} data-member={member.id} key={`${member.kind}:${member.id}`}>
						<span className={styles.grow}>
							{props.me.kind === "person" && member.kind === "person" && member.id === props.me.id
								? "You"
								: member.name}
						</span>
						<span className={styles.access}>{ACCESS_LABELS[member.access]}</span>
						{props.onRemove === undefined ? null : (
							<Button
								density="compact"
								hierarchy="tertiary"
								onClick={() => props.onRemove?.({ kind: member.kind, id: member.id })}
								semantic="negative"
							>
								Remove
							</Button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

/** How an access reads. */
const ACCESS_LABELS: Readonly<Record<Access, string>> = { read: "Reads", write: "Writes" };

/** The access a new member can get, as the owner picks it. */
const ACCESS_ITEMS = [
	{ value: "write", label: "Writes" },
	{ value: "read", label: "Reads" },
] as const;

/** The owner's pick of a person (from the loaded pages of their persons; `more` loads the next) and their access. */
function AddMember(props: {
	readonly persons: readonly { readonly value: string; readonly label: string }[];
	readonly more: (() => void) | undefined;
	readonly onAdd: (member: Member) => void;
	readonly action: Action;
}) {
	const [person, setPerson] = useState<string | undefined>(undefined);
	const [access, setAccess] = useState<Access>("write");
	const picked = person ?? props.persons[0]?.value;
	if (props.persons.length === 0) return <p className={styles.note}>Invite a person to add them here.</p>;
	return (
		<div className={styles.add} data-add-member="">
			<Choice items={props.persons} label="Add a person" name="person" onChange={setPerson} value={picked ?? null} />
			<Choice
				items={ACCESS_ITEMS}
				label="Access"
				name="access"
				// The items are the two accesses.
				onChange={(value) => setAccess(value as Access)}
				value={access}
			/>
			<Button
				disabled={picked === undefined}
				onClick={() => picked !== undefined && props.onAdd({ kind: "person", id: picked, access })}
				pending={props.action.pending}
			>
				Add
			</Button>
			{props.more === undefined ? null : (
				<Button density="compact" hierarchy="tertiary" onClick={props.more}>
					More persons
				</Button>
			)}
		</div>
	);
}
