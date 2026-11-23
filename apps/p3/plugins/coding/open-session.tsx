// One open session of the coding app: its header (back, title, what it holds) and its panes in the page's pane layout
// (`PaneLayout`, `/v1/web`): the transcript first, then each thing opened from the session's dialog (in the group
// beside the transcript; a new split on the right when there is none). The route names the focused pane
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
	PaneLayout,
	type PaneNode,
	panesOf,
	paneTree,
	parsePaneTree,
	redirect,
	SessionThingsView,
	ThingView,
	TranscriptView,
	useHold,
	usePageState,
	useVariant,
	useView,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useEffect, useMemo, useState } from "react";
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
	const info = useVariant(useHold(SessionInfo, { session }), "info");
	const row = useWatch(info?.session);
	const things = useWatch(info?.things);
	const [tree, setTree] = useLayout(session, props.person);
	const [holding, setHolding] = useState(false);
	const at = (thing: string | undefined) =>
		thing === undefined ? `/${app}/${session}` : `/${app}/${session}/${thing}`;
	const tidied = things === undefined ? tree : tidiedTree(tree, new Set(things.map(({ thing }) => thing)));
	// biome-ignore lint/correctness/useExhaustiveDependencies: `at` and `setTree` are made anew each render; what they read is listed.
	useEffect(() => {
		if (things === undefined) return;
		let next = tidied;
		// The route's pane shows in its group: a thing opened (a page loaded on its path) or activated, one the session
		// no longer has left for the transcript.
		const focus = props.active ?? TRANSCRIPT;
		if (!things.some(({ thing }) => thing === focus) && focus !== TRANSCRIPT) redirect(at(undefined));
		else if (groupOf(next, focus)?.active !== focus) next = openPane(next, focus, TRANSCRIPT);
		if (JSON.stringify(next) !== JSON.stringify(tree)) setTree(next);
	}, [things, tidied, tree, props.active]);
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
					<Button
						data-things-open=""
						density="compact"
						hierarchy="tertiary"
						iconStart={<FolderIcon />}
						onClick={() => setHolding(true)}
					>
						Session
					</Button>
				)}
			</header>
			<div className={styles.panes}>
				<PaneLayout
					focused={focused}
					onChange={setTree}
					onFocus={(pane) => navigate(at(pane === TRANSCRIPT ? undefined : pane))}
					panes={panes}
					tree={tidied}
				/>
			</div>
			<ThingsDialog
				onClose={() => setHolding(false)}
				onOpen={(thing) => {
					setHolding(false);
					setTree(openPane(tidied, thing, TRANSCRIPT));
					navigate(at(thing));
				}}
				open={holding}
				session={session}
			/>
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
 * What the session holds, in a dialog (rendered only while open: its objects are held only then); a thing's "Open"
 * goes to `onOpen`.
 */
function ThingsDialog(props: {
	readonly session: string;
	readonly open: boolean;
	readonly onClose: () => void;
	readonly onOpen: (thing: string) => void;
}) {
	const SessionThings = useView(SessionThingsView);
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
					<Modal.Popup className={styles.dialog} data-things-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>Session</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open && SessionThings !== undefined ? (
							<SessionThings onOpen={props.onOpen} session={props.session} />
						) : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}
