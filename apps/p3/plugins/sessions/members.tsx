// The view `SessionMembersView` ("Share" in the coding app): who is in a session, persons and groups, reading or
// writing. Everyone with access sees the list; the owner removes members and adds a person (one of `PeopleList`, not
// the owner, who writes every session, and not a member already), through `Sessions`.

import { Button, Heading } from "@earendil-works/elanor-react";
import { type Access, type Context, Me, type Member, PeopleList, SessionInfo, Sessions } from "@earendil-works/p3/v1";
import { useHold, useLive, useRefState, useWatch } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { type Action, useAction } from "./action.ts";
import { Choice } from "./choice.tsx";
import { useViewId } from "./session-list.tsx";
import styles from "./session-things.module.css";

/** A member as the view shows it: who, their access and their name. */
type ShownMember = Member & { readonly name: string };

/** Session `session`'s members; the owner manages them. */
export function SessionMembers(props: { readonly session: string }) {
	const infoRef = useHold(SessionInfo, { session: props.session });
	const state = useRefState(infoRef);
	const members = useWatch(useLive(infoRef)?.members);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	const action = useAction();
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You have no access to this session.</p>;
	}
	if (members === undefined || me === undefined) return <p className={styles.note}>Loading…</p>;
	// A page is never a session's worker.
	if (me.kind === "agent") return null;
	return (
		<div className={styles.things} data-session-members="">
			{me.owner ? (
				<ManagedMembers action={action} me={me.id} members={members} session={props.session} />
			) : (
				<Members me={me.id} members={members} />
			)}
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</div>
	);
}

/** The owner's members: removal, and the form that adds one. */
function ManagedMembers(props: {
	readonly session: string;
	readonly members: readonly ShownMember[];
	readonly me: string;
	readonly action: Action;
}) {
	const { session, action } = props;
	const sessions = useLive(useHold(Sessions, {}));
	const peopleRef = useLive(useHold(PeopleList, { view: useViewId() }));
	const people = useWatch(peopleRef?.list);
	const manage = (call: (owner: NonNullable<typeof sessions>, context: Context) => Promise<unknown>) => {
		if (sessions !== undefined) action.run((ctx) => call(sessions, ctx));
	};
	return (
		<>
			<Members
				me={props.me}
				members={props.members}
				onRemove={(party) => manage((owner, ctx) => owner.removeMember({ session, party }, ctx))}
			/>
			<AddMember
				action={action}
				more={
					peopleRef !== undefined && people?.moreAfter === true
						? () => action.run((ctx) => peopleRef.more(ctx))
						: undefined
				}
				onAdd={(member) => manage((owner, ctx) => owner.addMember({ session, member }, ctx))}
				persons={(people?.rows ?? [])
					.filter(
						(person) =>
							!person.owner &&
							!props.members.some((member) => member.kind === "person" && member.id === person.id),
					)
					.map((person) => ({ value: person.id, label: person.name }))}
			/>
		</>
	);
}

/** The session's members: who, and whether they read or write; `onRemove` if managed. */
function Members(props: {
	readonly members: readonly ShownMember[];
	readonly me: string;
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
							{member.kind === "person" && member.id === props.me ? "You" : member.name}
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
