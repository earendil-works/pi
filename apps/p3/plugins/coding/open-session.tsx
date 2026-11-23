// One open session of the coding app: its header (back, title, "Share" for its members, "Session" for what it holds;
// each a dialog) and its panes in the layout plugin's pane layout (`PaneLayoutView`): the transcript first, then each
// thing opened from the session's dialog, or appearing in the session while the page is open (in the group beside the
// transcript; a new split on the right when there is none). The route names the focused pane
// (`/coding/<session>/<thing>`; none: the transcript); the layout's tree is the person's on this device, per session:
// in page state (through reloads of this plugin) and the browser's storage (through page loads), under their id (two
// persons signing in on one browser keep theirs apart).

import { Button, IconButton, Modal, Stack } from "@earendil-works/elanor-react";
import { Me, SessionInfo } from "@earendil-works/p3/v1";
import {
	ArrowBackIcon,
	activatePane,
	CloseIcon,
	FolderIcon,
	groupOf,
	keepPanes,
	navigate,
	openPane,
	type Pane,
	PaneLayoutView,
	type PaneNode,
	PersonAddIcon,
	panesOf,
	paneTree,
	parsePaneTree,
	redirect,
	SessionMembersView,
	SessionThingsView,
	ThingView,
	ThingViews,
	TranscriptView,
	useHold,
	usePageState,
	useRegistry,
	useVariant,
	useView,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import styles from "./web.module.css";

/** The transcript's pane id: no thing has it (things' ids are the sessions plugin's UUIDs). */
const TRANSCRIPT = "transcript";

/** Session `session` of app `app`, with `active` the thing the route focuses (none: the transcript). */
export function OpenSession(props: { readonly app: string; readonly session: string; readonly active?: string }) {
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	// The layout is the person's: it waits for who they are.
	return me?.kind === "person" ? <SessionPanes {...props} person={me.id} /> : null;
}

/** The session's header, its panes and its dialog, with the layout of person `person`. */
function SessionPanes(props: {
	readonly app: string;
	readonly session: string;
	readonly active?: string;
	readonly person: string;
}) {
	const { app, session } = props;
	const Transcript = useView(TranscriptView);
	const Layout = useView(PaneLayoutView);
	const info = useVariant(useHold(SessionInfo, { session }), "info");
	const row = useWatch(info?.session);
	const things = useWatch(info?.things);
	const [tree, setTree] = useLayout(session, props.person);
	const SessionThings = useView(SessionThingsView);
	const SessionMembers = useView(SessionMembersView);
	const views = useRegistry(ThingViews);
	// Which of the session's dialogs is open: its sheet, or its members ("Share").
	const [opened, setOpened] = useState<"things" | "members" | undefined>(undefined);
	// The things the session had when this page first saw it and since: one that appears later opens by itself.
	const seen = useRef<Set<string> | undefined>(undefined);
	const at = (thing: string | undefined) =>
		thing === undefined ? `/${app}/${session}` : `/${app}/${session}/${thing}`;
	const tidied = things === undefined ? tree : tidiedTree(tree, new Set(things.map(({ thing }) => thing)));
	// biome-ignore lint/correctness/useExhaustiveDependencies: `at` and `setTree` are made anew each render; what they read is listed.
	useEffect(() => {
		if (things === undefined) return;
		let next = tidied;
		// A thing that appears while the page is open (made by the agent, added by anyone) opens as a pane beside the
		// transcript, without taking the focus; not those the session had when the page first saw it.
		if (seen.current === undefined) seen.current = new Set(things.map(({ thing }) => thing));
		for (const { thing, kind } of things) {
			if (seen.current.has(thing)) continue;
			seen.current.add(thing);
			if (views?.get(kind)?.value.View !== undefined) next = openPane(next, thing, TRANSCRIPT);
		}
		// The route's pane shows in its group: a thing opened (a page loaded on its path) or activated, one the session
		// no longer has left for the transcript.
		const focus = props.active ?? TRANSCRIPT;
		if (!things.some(({ thing }) => thing === focus) && focus !== TRANSCRIPT) redirect(at(undefined));
		else if (groupOf(next, focus)?.active !== focus) next = openPane(next, focus, TRANSCRIPT);
		if (JSON.stringify(next) !== JSON.stringify(tree)) setTree(next);
	}, [things, tidied, tree, props.active, views]);
	const panes: Pane[] = [
		{
			id: TRANSCRIPT,
			title: "Transcript",
			closable: false,
			render: () => (Transcript === undefined ? null : <Transcript key={session} session={session} />),
		},
		...(things ?? []).map(({ thing, kind, name, title }) => ({
			id: thing,
			// A thing's tab shows its name in the session, else its kind's title: two canvases are "Plan" and "Sketches".
			title: name === "" ? title : name,
			closable: true,
			render: () => (
				<div className={styles.paneScroll}>
					<ThingView fallback={<p>{name === "" ? title : name}</p>} kind={kind} session={session} thing={thing} />
				</div>
			),
		})),
	];
	const focused = props.active ?? TRANSCRIPT;
	const title = row === undefined ? "" : row.title === "" ? "New session" : row.title;
	const onThing = props.active !== undefined;
	return (
		<>
			<header className={styles.header}>
				<IconButton
					aria-label={onThing ? "Back to the transcript" : "Back to the sessions"}
					className={styles.back}
					onClick={() => navigate(onThing ? at(undefined) : `/${app}`)}
				>
					<ArrowBackIcon />
				</IconButton>
				<h2 className={styles.title} data-session-title="">
					{title}
				</h2>
				{row === undefined ? null : (
					<>
						<Button
							data-members-open=""
							density="compact"
							hierarchy="tertiary"
							iconStart={<PersonAddIcon />}
							onClick={() => setOpened("members")}
						>
							Share
						</Button>
						<Button
							data-things-open=""
							density="compact"
							hierarchy="tertiary"
							iconStart={<FolderIcon />}
							onClick={() => setOpened("things")}
						>
							Session
						</Button>
					</>
				)}
			</header>
			<div className={styles.panes}>
				{Layout === undefined ? null : (
					<Layout
						focused={focused}
						onChange={setTree}
						onFocus={(pane) => navigate(at(pane === TRANSCRIPT ? undefined : pane))}
						panes={panes}
						tree={tidied}
					/>
				)}
			</div>
			<SessionDialog
				data={{ "data-things-dialog": "" }}
				onClose={() => setOpened(undefined)}
				open={opened === "things"}
				title="Session"
			>
				{SessionThings === undefined ? null : (
					<SessionThings
						onOpen={(thing) => {
							setOpened(undefined);
							setTree(openPane(tidied, thing, TRANSCRIPT));
							navigate(at(thing));
						}}
						session={session}
					/>
				)}
			</SessionDialog>
			<SessionDialog
				data={{ "data-members-dialog": "" }}
				onClose={() => setOpened(undefined)}
				open={opened === "members"}
				title="Share"
			>
				{SessionMembers === undefined ? null : <SessionMembers session={session} />}
			</SessionDialog>
		</>
	);
}

/**
 * The layout's tree of `session` for person `person` on this device, and its setter: page state first (it survives a
 * reload of this plugin), seeded from the browser's storage (it survives a page load), else the transcript alone.
 * Every change is written to both.
 */
function useLayout(session: string, person: string): readonly [PaneNode, (tree: PaneNode) => void] {
	const key = `p3.coding.panes.${person}.${session}`;
	const initial = useMemo(() => storedTree(key) ?? paneTree([TRANSCRIPT]), [key]);
	const [tree, setPageTree] = usePageState<PaneNode>(`coding.panes.${person}.${session}`, initial);
	const set = (next: PaneNode) => {
		setPageTree(next);
		try {
			localStorage.setItem(key, JSON.stringify(next));
		} catch {
			// Storage full or refused (a private window): the layout lives as long as the page.
		}
	};
	return [tree, set];
}

/** The tree stored under `key`, if a readable one is there. */
function storedTree(key: string): PaneNode | undefined {
	try {
		const text = localStorage.getItem(key);
		// A trust boundary: what the browser's storage holds (another version's, a person's edit).
		return text === null ? undefined : parsePaneTree(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/** `tree` with only the transcript and the session's `things`, the transcript always in it. */
function tidiedTree(tree: PaneNode, things: ReadonlySet<string>): PaneNode {
	const kept = keepPanes(tree, (pane) => pane === TRANSCRIPT || things.has(pane)) ?? paneTree([TRANSCRIPT]);
	return panesOf(kept).includes(TRANSCRIPT) ? kept : activatePane(openPane(kept, TRANSCRIPT, TRANSCRIPT), TRANSCRIPT);
}

/**
 * A dialog of the session (its sheet, its members), titled `title`; its content rendered only while open, so its
 * objects are held only then.
 */
function SessionDialog(props: {
	readonly title: string;
	readonly open: boolean;
	readonly onClose: () => void;
	readonly data: Readonly<Record<`data-${string}`, string>>;
	readonly children: ReactNode;
}) {
	return (
		<Modal.Root
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open={props.open}
		>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} {...props.data}>
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>{props.title}</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open ? props.children : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}
