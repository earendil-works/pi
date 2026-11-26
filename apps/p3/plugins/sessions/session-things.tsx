// The view `SessionThingsView`, the session sheet: what a session holds, calm on a phone. Its things as rows (the
// kind's icon, the name, one muted line of whose it is or whom it comes from); a tap opens one where the app shows
// things, when its kind has a view. Each row's "⋯" holds what the caller may do with it: rename, options, keep (give
// the session's content an owner), remove (not a thing the session has from whom it follows). A writer's "+" makes
// content at once (named after its kind, renamed later) or links one of their own ("One of mine…"). At the foot,
// for the owner, whom the session follows ("Has your things · Change"), and where it works. Members are another view
// (`SessionMembersView`).

import { Heading, IconButton, Menu } from "@earendil-works/elanor-react";
import {
	type Context,
	Me,
	type Member,
	type Party,
	type Reference,
	SESSION_THINGS_WRITES,
	SessionInfo,
	type SessionRow,
	Sessions,
	type SessionThing,
	SessionThings as SessionThingsObject,
	type With,
	withGranted,
} from "@earendil-works/p3/v1";
import { AddIcon, useHold, useLive, useRefState, useRegistry, useWatch } from "@earendil-works/p3/v1/web";
import { type ReactNode, useState } from "react";
import { type Action, useAction } from "./action.ts";
import { AddExistingDialog } from "./add-existing.tsx";
import { ThingViews } from "./contract.web.tsx";
import { type FollowChoice, FollowLine, followName } from "./following.tsx";
import { GivePanel, keepersOf, type OwnerChoice } from "./give-thing.tsx";
import styles from "./session-things.module.css";
import { RenameField } from "./thing-name.tsx";
import { type ThingOptionsOf, ThingOptionsPanel } from "./thing-options.tsx";
import { type RowAction, ThingRow } from "./thing-row.tsx";

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

/** Session `session`'s sheet; writers make and manage things, the owner also whom it follows. */
export function SessionThings(props: { readonly session: string; readonly onOpen?: (thing: string) => void }) {
	const infoRef = useHold(SessionInfo, { session: props.session });
	const info = useLive(infoRef);
	const state = useRefState(infoRef);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
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
			<SheetThings sheet={sheet} />
			<footer className={styles.foot}>
				{me.owner ? <OwnerFollowing sheet={sheet} /> : null}
				<p className={styles.location} data-location="">
					{row.location.environment}: {row.location.folder}
				</p>
			</footer>
			{action.error === undefined ? null : <p className={styles.error}>{action.error}</p>}
		</div>
	);
}

/** The owner's line of whom the session follows, with its change (`Sessions.follow`, keeping what it had). */
function OwnerFollowing(props: { readonly sheet: Sheet }) {
	const { sheet } = props;
	const sessions = useLive(useHold(Sessions, {}));
	const you: FollowChoice = { party: { kind: "person", id: sheet.me.id }, name: "You" };
	const members = sheet.members
		.filter((member) => !(member.kind === "person" && member.id === sheet.me.id))
		.map((member) => ({ party: { kind: member.kind, id: member.id }, name: member.name }));
	return (
		<FollowLine
			action={sheet.action}
			choices={[you, ...members]}
			follows={sheet.row.follows}
			name={followName(sheet.row.follows, sheet.me.id, sheet.followsName)}
			onFollow={(follows: Party | null) => {
				if (sessions === undefined) return;
				sheet.action.run((ctx) => sessions.follow({ session: sheet.row.id, follows, keep: true }, ctx));
			}}
		/>
	);
}

/** What a row's action opened under it. */
type Panel = { readonly thing: string; readonly kind: "rename" | "options" | "keep" };

/**
 * The things as rows with what the viewer's `SessionThings` lets them do (a writer's; a reader's has nothing), and a
 * writer's "+".
 */
function SheetThings(props: { readonly sheet: Sheet }) {
	const { sheet } = props;
	const { action } = sheet;
	const writer = withGranted(
		useLive(useHold(SessionThingsObject, { session: sheet.row.id })),
		...SESSION_THINGS_WRITES,
	);
	const kinds = useWatch(writer?.kinds) ?? [];
	const owners = useWatch(writer?.owners) ?? [];
	const [panel, setPanel] = useState<Panel | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const run = (call: (thing: NonNullable<typeof writer>, context: Context) => Promise<unknown>) => {
		if (writer !== undefined) action.run((ctx) => call(writer, ctx));
	};
	return (
		<section aria-label="Things" className={styles.section}>
			<div className={styles.sheetHead}>
				<Heading level={3} size={6}>
					Things
				</Heading>
				{writer === undefined ? null : (
					<AddMenu
						kinds={kinds}
						onExisting={() => setAdding(true)}
						onNew={(kind) => run((w, ctx) => w.create({ kind }, ctx))}
					/>
				)}
			</div>
			{sheet.things.length === 0 ? <p className={styles.note}>Nothing yet.</p> : null}
			<ul className={styles.items}>
				{sheet.things.map((thing) => (
					<SheetThing
						key={thing.thing}
						owners={owners}
						panel={panel?.thing === thing.thing ? panel.kind : undefined}
						run={run}
						setPanel={setPanel}
						sheet={sheet}
						thing={thing}
						writer={writer}
					/>
				))}
			</ul>
			{writer === undefined ? null : (
				<AddExistingDialog
					action={action}
					onAdd={(thing) => run((w, ctx) => w.add({ thing }, ctx))}
					onClose={() => setAdding(false)}
					open={adding}
					present={new Set(sheet.things.map((thing) => thing.thing))}
				/>
			)}
		</section>
	);
}

/** The writer's `SessionThings` as rows call it (`undefined`: a reader). */
type Writer = With<Reference<typeof SessionThingsObject>, (typeof SESSION_THINGS_WRITES)[number]> | undefined;

/** One thing's row: its line, its actions (those the viewer may take) and the panel one of them opened. */
function SheetThing(props: {
	readonly thing: ShownThing;
	readonly sheet: Sheet;
	readonly writer: Writer;
	readonly owners: readonly OwnerChoice[];
	readonly panel: Panel["kind"] | undefined;
	readonly setPanel: (panel: Panel | undefined) => void;
	readonly run: (call: (thing: NonNullable<Writer>, context: Context) => Promise<unknown>) => void;
}) {
	const { thing, sheet, writer, owners, run } = props;
	const { action } = sheet;
	const entry = useRegistry(ThingViews)?.get(thing.kind)?.value;
	const from = followName(sheet.row.follows, sheet.me.id, sheet.followsName);
	const close = () => props.setPanel(undefined);
	const managed = writer !== undefined && manages(thing, sheet.me);
	const followed = thing.by.kind === "followed";
	// An action opens its panel, or closes it when it is the one open.
	const open = (kind: Panel["kind"]) => () =>
		props.setPanel(props.panel === kind ? undefined : { thing: thing.thing, kind });
	const actions: RowAction[] = [
		...(managed ? [{ key: "rename", label: "Rename", run: open("rename") }] : []),
		...(managed && entry?.Options !== undefined ? [{ key: "options", label: "Options", run: open("options") }] : []),
		...(writer !== undefined && thing.owner.kind === "none" && keepersOf(owners, thing.owner).length > 0
			? [{ key: "keep", label: "Keep", run: open("keep") }]
			: []),
		...(managed && !followed
			? [
					{
						key: "remove",
						label: "Remove",
						run: () => run((w, ctx) => w.remove({ thing: thing.thing }, ctx)),
					},
				]
			: []),
	];
	const shown = props.panel;
	let below: ReactNode = null;
	if (shown === "rename") {
		below = (
			<RenameField
				action={action}
				name={thing.name}
				onDone={close}
				onRename={(name) => run((w, ctx) => w.rename({ thing: thing.thing, name }, ctx))}
				title={thing.title}
			/>
		);
	} else if (shown === "options") {
		below = (
			<ThingOptionsPanel
				action={action}
				members={sheet.members}
				onSave={(forWhom, options) =>
					run((w, ctx) => w.setOptions({ thing: thing.thing, for: forWhom, options }, ctx))
				}
				session={sheet.row.id}
				thing={thing}
			/>
		);
	} else if (shown === "keep") {
		below = (
			<GivePanel
				action={action}
				current={thing.owner}
				label="Keep"
				onDone={close}
				onGive={(owner) => run((w, ctx) => w.keep({ thing: thing.thing, owner }, ctx))}
				owners={owners}
			/>
		);
	}
	return (
		<ThingRow
			actions={actions}
			data={{
				"data-thing": thing.kind,
				"data-thing-id": thing.thing,
				"data-by": thing.by.kind === "person" ? `person:${thing.by.id}` : thing.by.kind,
				"data-owner":
					thing.owner.kind === "person" || thing.owner.kind === "group"
						? `${thing.owner.kind}:${thing.owner.id}`
						: thing.owner.kind,
			}}
			kind={thing.kind}
			line={followed ? `From ${from === "You" ? "you" : from}` : whose(thing, sheet.me)}
			name={thing.name === "" ? thing.title : thing.name}
			onOpen={
				sheet.onOpen === undefined || entry?.View === undefined ? undefined : () => sheet.onOpen?.(thing.thing)
			}
			panel={below}
		/>
	);
}

/** A writer's "+": a new thing of one of `kinds` (made at once), or "One of mine…". */
function AddMenu(props: {
	readonly kinds: readonly { readonly kind: string; readonly title: string }[];
	readonly onNew: (kind: string) => void;
	readonly onExisting: () => void;
}) {
	return (
		<Menu.Root>
			<Menu.Trigger data-add-open="" render={<IconButton aria-label="Add a thing" />}>
				<AddIcon />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={4}>
					<Menu.Popup data-add-popup="">
						{props.kinds.map((kind) => (
							<Menu.Item data-new-kind={kind.kind} key={kind.kind} onClick={() => props.onNew(kind.kind)}>
								{kind.title}
							</Menu.Item>
						))}
						{props.kinds.length === 0 ? null : <Menu.Separator />}
						<Menu.Item data-add-existing-open="" onClick={props.onExisting}>
							One of mine…
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
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
