// The view `SessionThingsView`: what a session holds, opened on demand. Everyone with access sees its location, its
// things (each in its kind's view, `<ThingView>`) and its members; the owner also adds and removes things (the kinds
// of `ThingKindCatalog`) and members (the persons of `PeopleList`), through `Sessions`.

import { Button, Heading } from "@earendil-works/elanor-react";
import {
	type Access,
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
import { Choice } from "./choice.tsx";
import { ThingView } from "./contract.web.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";

/** What a view shows while it knows no kind's title or person's name: kinds by name, persons by id. */
const NO_TITLES: ReadonlyMap<string, string> = new Map();
const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** Session `session`'s things and members; the owner manages them. */
export function SessionThings(props: { readonly session: string }) {
	const infoRef = useHold(SessionInfo, { session: props.session });
	const info = useVariant(infoRef, "info");
	const state = useRefState(infoRef);
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const row = useWatch(info?.session);
	const things = useWatch(info?.things);
	const members = useWatch(info?.members);
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You have no access to this session.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This session cannot be shown now.</p>;
	}
	if (row === undefined || things === undefined || members === undefined || me === undefined) {
		return <p className={styles.note}>Loading…</p>;
	}
	if (me.kind === "owner") return <Managed row={row} things={things} members={members} />;
	return (
		<div className={styles.things} data-session-things="">
			<Location row={row} />
			<Things session={row.id} things={things} titles={NO_TITLES} />
			<Members members={members} names={NO_NAMES} />
		</div>
	);
}

/** The owner's view: the lists with their removals, and the forms that add a thing and a member. */
function Managed(props: {
	readonly row: SessionRow;
	readonly things: readonly Pick<SessionThing, "thing" | "kind">[];
	readonly members: readonly Member[];
}) {
	const session = props.row.id;
	const sessions = useVariant(useHold(Sessions, {}), "owner");
	const kinds = useWatch(useVariant(useHold(ThingKindCatalog, {}), "owner")?.kinds) ?? [];
	const peopleRef = useVariant(useHold(PeopleList, { view: useViewId() }), "owner");
	const people = useWatch(peopleRef?.list);
	const change = useAction();
	const manage = (call: (owner: NonNullable<typeof sessions>, context: Context) => Promise<unknown>) => {
		if (sessions !== undefined) change.run((ctx) => call(sessions, ctx));
	};
	const titles = new Map(kinds.map((kind) => [kind.kind, kind.title] as const));
	const names = new Map((people?.rows ?? []).map((person) => [person.id, person.name] as const));
	return (
		<div className={styles.things} data-session-things="">
			<Location row={props.row} />
			<Things
				session={session}
				things={props.things}
				titles={titles}
				onRemove={(thing) => manage((owner, ctx) => owner.removeThing({ session, thing }, ctx))}
			/>
			<AddThing
				kinds={kinds.map((kind) => ({ value: kind.kind, label: kind.title }))}
				onAdd={(kind) => manage((owner, ctx) => owner.addThing({ session, thing: { kind } }, ctx))}
				action={change}
			/>
			<Members
				members={props.members}
				names={names}
				onRemove={(party) => manage((owner, ctx) => owner.removeMember({ session, party }, ctx))}
			/>
			<AddMember
				persons={(people?.rows ?? []).map((person) => ({ value: person.id, label: person.name }))}
				more={
					peopleRef !== undefined && people?.moreAfter === true
						? () => change.run((ctx) => peopleRef.more(ctx))
						: undefined
				}
				onAdd={(member) => manage((owner, ctx) => owner.addMember({ session, member }, ctx))}
				action={change}
			/>
			{change.error === undefined ? null : <p className={styles.error}>{change.error}</p>}
		</div>
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

/** The session's things, each in its kind's view (its kind's title while no plugin shows it); `onRemove` if managed. */
function Things(props: {
	readonly session: string;
	readonly things: readonly Pick<SessionThing, "thing" | "kind">[];
	readonly titles: ReadonlyMap<string, string>;
	readonly onRemove?: (thing: string) => void;
}) {
	return (
		<section aria-label="Things" className={styles.section}>
			<Heading level={3} size={6}>
				Things
			</Heading>
			{props.things.length === 0 ? <p className={styles.note}>None.</p> : null}
			<ul className={styles.items}>
				{props.things.map((thing) => (
					<li className={styles.item} data-thing={thing.kind} key={thing.thing}>
						<div className={styles.grow}>
							<ThingView
								fallback={<span>{props.titles.get(thing.kind) ?? thing.kind}</span>}
								kind={thing.kind}
								session={props.session}
								thing={thing.thing}
							/>
						</div>
						{props.onRemove === undefined ? null : (
							<Button
								density="compact"
								hierarchy="tertiary"
								onClick={() => props.onRemove?.(thing.thing)}
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
	readonly members: readonly Member[];
	readonly names: ReadonlyMap<string, string>;
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
							{props.names.get(member.id) ?? `${member.kind === "group" ? "Group" : "Person"} ${member.id}`}
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
