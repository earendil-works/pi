// The view `SessionThingsView`, the session sheet: what a session holds, opened on demand. Everyone with access sees
// its location, whom it follows, its things (each by its name, else its kind's title, with whose it is, "from" whom
// the session follows for a thing it has that way, and "Open" when the app shows things and the kind has a view) and
// its members. A writer (a person or the owner) makes content here ("New": the session's kinds of content, owned by
// nobody), adds a thing they manage ("Add existing"), gives content an owner ("Keep"), and removes, renames and sets
// the options of the things they manage (a thing the session follows is not removed here); the owner also changes
// whom the session follows, and adds and removes members (the persons of `PeopleList`), through `Sessions`.

import { Button, Heading } from "@earendil-works/elanor-react";
import {
	type Access,
	type Context,
	Me,
	type Member,
	type Party,
	PeopleList,
	SessionInfo,
	type SessionRow,
	Sessions,
	type SessionThing,
	SessionThings as SessionThingsObject,
} from "@earendil-works/p3/v1";
import { useHold, useRefState, useRegistry, useVariant, useWatch } from "@earendil-works/p3/v1/web";
import { type ReactNode, useState } from "react";
import { type Action, useAction } from "./action.ts";
import { AddExisting } from "./add-existing.tsx";
import { Choice } from "./choice.tsx";
import { ThingViews } from "./contract.web.tsx";
import { type FollowChoice, Following, followName } from "./following.tsx";
import { GiveThing } from "./give-thing.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";
import { NameField, ThingName } from "./thing-name.tsx";
import { ThingOptions, type ThingOptionsOf } from "./thing-options.tsx";

/** Who the viewer is, as `Me` answers for a person (the owner among them). */
type Viewer = { readonly id: string; readonly name: string; readonly owner: boolean };

/** A thing as the view shows it: its id, kind, name, owner (and their name), its kind's title and its options. */
type ShownThing = Pick<SessionThing, "thing" | "kind" | "name" | "owner" | "by"> &
	ThingOptionsOf & { readonly title: string; readonly ownerName: string; readonly byName: string };

/** A member as the view shows it: who, their access and their name. */
type ShownMember = Member & { readonly name: string };

/** What every part of the sheet reads: the session, the viewer, its things and members, and the sheet's action. */
type Sheet = {
	readonly row: SessionRow;
	readonly followsName: string;
	readonly things: readonly ShownThing[];
	readonly members: readonly ShownMember[];
	readonly me: Viewer;
	readonly onOpen: ((thing: string) => void) | undefined;
	readonly action: Action;
};

/** Session `session`'s sheet; writers make and manage things, the owner also members and whom it follows. */
export function SessionThings(props: { readonly session: string; readonly onOpen?: (thing: string) => void }) {
	const infoRef = useHold(SessionInfo, { session: props.session });
	const info = useVariant(infoRef, "info");
	const state = useRefState(infoRef);
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const row = useWatch(info?.session);
	const things = useWatch(info?.things);
	const members = useWatch(info?.members);
	const followsName = useWatch(info?.followsName);
	const action = useAction();
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You have no access to this session.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This session cannot be shown now.</p>;
	}
	if (
		row === undefined ||
		things === undefined ||
		members === undefined ||
		followsName === undefined ||
		me === undefined
	) {
		return <p className={styles.note}>Loading…</p>;
	}
	// A page is never a session's worker.
	if (me.kind === "agent") return null;
	const sheet: Sheet = { row, followsName, things, members, me, onOpen: props.onOpen, action };
	return (
		<div className={styles.things} data-session-things="">
			<Location row={row} />
			{me.owner ? <OwnerFollowing sheet={sheet} /> : <Following {...followingOf(sheet)} onFollow={undefined} />}
			<SheetThings sheet={sheet} />
			{me.owner ? <ManagedMembers sheet={sheet} /> : <Members me={me} members={members} />}
			<Failures errors={[action.error]} />
		</div>
	);
}

/**
 * Whom the session follows and its name (the viewer as "You"), and the parties the owner may make it follow
 * (themselves as "You", its members).
 */
function followingOf(sheet: Sheet): {
	follows: Party | null;
	name: string;
	choices: readonly FollowChoice[];
	action: Action;
} {
	const you: FollowChoice = { party: { kind: "person", id: sheet.me.id }, name: "You" };
	const members = sheet.members
		.filter((member) => !(member.kind === "person" && member.id === sheet.me.id))
		.map((member) => ({ party: { kind: member.kind, id: member.id }, name: member.name }));
	return {
		follows: sheet.row.follows,
		name: followName(sheet.row.follows, sheet.me.id, sheet.followsName),
		choices: sheet.me.owner ? [you, ...members] : [],
		action: sheet.action,
	};
}

/** The owner's "Follows" with its change (`Sessions.follow`, keeping what the session had). */
function OwnerFollowing(props: { readonly sheet: Sheet }) {
	const sessions = useVariant(useHold(Sessions, {}), "owner");
	const { sheet } = props;
	return (
		<Following
			{...followingOf(sheet)}
			onFollow={
				sessions === undefined
					? undefined
					: (follows) =>
							sheet.action.run((ctx) => sessions.follow({ session: sheet.row.id, follows, keep: true }, ctx))
			}
		/>
	);
}

/**
 * The things with what the viewer's `SessionThings` lets them do (a writer's; a reader's has nothing): open, rename,
 * set the options of, keep and remove the things they manage (`manages`: the server decides again), make content
 * here ("New") and add a thing they manage ("Add existing").
 */
function SheetThings(props: { readonly sheet: Sheet }) {
	const { sheet } = props;
	const { action } = sheet;
	const writer = useVariant(useHold(SessionThingsObject, { session: sheet.row.id }), "writer");
	const kinds = useWatch(writer?.kinds) ?? [];
	const owners = useWatch(writer?.owners) ?? [];
	const titles = new Map([
		...sheet.things.map((thing) => [thing.kind, thing.title] as const),
		...kinds.map((kind) => [kind.kind, kind.title] as const),
	]);
	const from = `From ${followingOf(sheet).name}`;
	const run = (call: (thing: NonNullable<typeof writer>, context: Context) => Promise<unknown>) => {
		if (writer !== undefined) action.run((ctx) => call(writer, ctx));
	};
	return (
		<>
			<Things
				describe={(thing) => {
					const managed = writer !== undefined && manages(thing, sheet.me);
					const followed = thing.by.kind === "followed";
					return {
						whose: followed ? `${whose(thing, sheet.me)} · ${from}` : whose(thing, sheet.me),
						rename: managed ? (name) => run((w, ctx) => w.rename({ thing: thing.thing, name }, ctx)) : undefined,
						options: managed ? (
							<ThingOptions
								action={action}
								members={sheet.members}
								onSave={(forWhom, options) =>
									run((w, ctx) => w.setOptions({ thing: thing.thing, for: forWhom, options }, ctx))
								}
								session={sheet.row.id}
								thing={thing}
							/>
						) : null,
						actions: (
							<>
								{writer === undefined || thing.owner.kind !== "none" ? null : (
									<GiveThing
										action={action}
										current={thing.owner}
										label="Keep"
										onGive={(owner) => run((w, ctx) => w.keep({ thing: thing.thing, owner }, ctx))}
										owners={owners}
									/>
								)}
								{!managed || followed ? null : (
									<Button
										data-remove-thing=""
										density="compact"
										hierarchy="tertiary"
										onClick={() => run((w, ctx) => w.remove({ thing: thing.thing }, ctx))}
										semantic="negative"
									>
										Remove
									</Button>
								)}
							</>
						),
					};
				}}
				onOpen={sheet.onOpen}
				session={sheet.row.id}
				things={sheet.things}
				action={action}
			/>
			{writer === undefined ? null : (
				<>
					<NewThing
						action={action}
						kinds={kinds.map((kind) => ({ value: kind.kind, label: kind.title }))}
						onAdd={(kind, name) => run((w, ctx) => w.create({ kind, ...(name === "" ? {} : { name }) }, ctx))}
					/>
					<AddExisting
						action={action}
						onAdd={(thing) => run((w, ctx) => w.add({ thing }, ctx))}
						present={new Set(sheet.things.map((thing) => thing.thing))}
						titles={titles}
					/>
				</>
			)}
		</>
	);
}

/** Whether the viewer manages `thing` as the page can tell: the owner any, a person their own and nobody's. */
function manages(thing: ShownThing, me: Viewer): boolean {
	if (me.owner) return true;
	return thing.owner.kind === "none" || (thing.owner.kind === "person" && thing.owner.id === me.id);
}

/** Whose a thing is, as the viewer `me` reads it: yours, a person's or a group's by name, the Pi's, or the session's. */
function whose(thing: ShownThing, me: Viewer): string {
	switch (thing.owner.kind) {
		case "none":
			return "This session's";
		case "pi":
			return "The Pi's";
		case "group":
			return `${thing.ownerName}'s`;
		case "person":
			return thing.owner.id === me.id ? "Yours" : `${thing.ownerName}'s`;
	}
}

/** The owner's members: removal, and the form that adds one. */
function ManagedMembers(props: { readonly sheet: Sheet }) {
	const { sheet } = props;
	const session = sheet.row.id;
	const sessions = useVariant(useHold(Sessions, {}), "owner");
	const peopleRef = useVariant(useHold(PeopleList, { view: useViewId() }), "owner");
	const people = useWatch(peopleRef?.list);
	const manage = (call: (owner: NonNullable<typeof sessions>, context: Context) => Promise<unknown>) => {
		if (sessions !== undefined) sheet.action.run((ctx) => call(sessions, ctx));
	};
	return (
		<>
			<Members
				me={sheet.me}
				members={sheet.members}
				onRemove={(party) => manage((owner, ctx) => owner.removeMember({ session, party }, ctx))}
			/>
			<AddMember
				action={sheet.action}
				more={
					peopleRef !== undefined && people?.moreAfter === true
						? () => sheet.action.run((ctx) => peopleRef.more(ctx))
						: undefined
				}
				onAdd={(member) => manage((owner, ctx) => owner.addMember({ session, member }, ctx))}
				// Not the owner (they write every session), not who is a member already.
				persons={(people?.rows ?? [])
					.filter(
						(person) =>
							!person.owner &&
							!sheet.members.some((member) => member.kind === "person" && member.id === person.id),
					)
					.map((person) => ({ value: person.id, label: person.name }))}
			/>
		</>
	);
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

/** What a thing's row shows besides its name: whose it is, its rename, its options control and its actions. */
type Described = {
	readonly whose: string;
	readonly rename: ((name: string) => void) | undefined;
	readonly options: ReactNode;
	readonly actions: ReactNode;
};

/**
 * The session's things, each by its name (`ThingName`) with what `describe` gives it, and "Open" when `onOpen` is
 * given and its kind has a view.
 */
function Things(props: {
	readonly session: string;
	readonly things: readonly ShownThing[];
	readonly onOpen: ((thing: string) => void) | undefined;
	readonly describe: (thing: ShownThing) => Described;
	readonly action: Action;
}) {
	const views = useRegistry(ThingViews);
	return (
		<section aria-label="Things" className={styles.section}>
			<Heading level={3} size={6}>
				Things
			</Heading>
			{props.things.length === 0 ? <p className={styles.note}>None.</p> : null}
			<ul className={styles.items}>
				{props.things.map((thing) => {
					const described = props.describe(thing);
					return (
						<li
							className={styles.item}
							data-by={thing.by.kind === "person" ? `person:${thing.by.id}` : thing.by.kind}
							data-owner={
								thing.owner.kind === "person" || thing.owner.kind === "group"
									? `${thing.owner.kind}:${thing.owner.id}`
									: thing.owner.kind
							}
							data-thing={thing.kind}
							data-thing-id={thing.thing}
							key={thing.thing}
						>
							<div className={styles.grow}>
								<ThingName
									action={props.action}
									name={thing.name}
									rename={described.rename}
									title={thing.title}
								/>
								<span className={styles.whose} data-whose="">
									{described.whose}
								</span>
								{described.options}
							</div>
							<div className={styles.rowActions}>
								{props.onOpen === undefined || views?.get(thing.kind)?.value.View === undefined ? null : (
									<Button
										data-open-thing={thing.thing}
										density="compact"
										hierarchy="secondary"
										onClick={() => props.onOpen?.(thing.thing)}
									>
										Open
									</Button>
								)}
								{described.actions}
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** "New": a writer's pick of a kind of content to make here, with its optional name (empty: the kind's title). */
function NewThing(props: {
	readonly kinds: readonly { readonly value: string; readonly label: string }[];
	readonly onAdd: (kind: string, name: string) => void;
	readonly action: Action;
}) {
	const [kind, setKind] = useState<string | undefined>(undefined);
	const [name, setName] = useState("");
	const picked = props.kinds.find((each) => each.value === kind) ?? props.kinds[0];
	if (props.kinds.length === 0) return null;
	return (
		<div className={styles.add} data-add-thing="">
			<Choice items={props.kinds} label="New" name="kind" onChange={setKind} value={picked?.value ?? null} />
			<NameField onChange={setName} title={picked?.label} value={name} />
			<Button
				data-add-thing-save=""
				disabled={picked === undefined}
				onClick={() => {
					if (picked === undefined) return;
					props.onAdd(picked.value, name.trim());
					setName("");
				}}
				pending={props.action.pending}
			>
				Make
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
							{member.kind === "person" && member.id === props.me.id ? "You" : member.name}
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
