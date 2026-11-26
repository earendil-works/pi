// The transcript view of a session workspace (the session kind's view, decisions 59 and 76; was the coding app's
// page): the session's panes in the layout plugin's pane layout (`PaneLayout`), the transcript first, then each thing
// here that has a view, drawn by `TargetView`; one that appears while the page is open (made by the agent, added by
// anyone) opens beside the transcript by itself. The route's rest names the focused pane (`/w/<session>/<thing>`;
// none: the transcript); the layout is the person's on this device, per session, in page state (through reloads of
// this plugin) and the browser's storage (through page loads).

import { Me } from "@earendil-works/p3/v1";
import {
	navigate,
	redirect,
	targetPath,
	useComponent,
	useHold,
	useLive,
	useMessages,
	usePageState,
	useRegistry,
	useRoute,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useEffect, useMemo, useRef, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet (a component token would be `undefined`).
import {
	activatePane,
	groupOf,
	keepPanes,
	openPane,
	type Pane,
	PaneLayout,
	type PaneNode,
	panesOf,
	paneTree,
	parsePaneTree,
	sameTree,
} from "../layout/contract.web.tsx";
import { TargetView, type ThingViewProps, Views, viewsKey } from "../things/contract.web.tsx";
import { WorkspaceContents } from "../things/workspace.ts";
import { messages } from "./messages.ts";
import styles from "./session-view.module.css";
import { TranscriptPane } from "./transcript-pane.tsx";

/** The transcript's pane id: no thing has it (things' ids are UUIDs). */
const TRANSCRIPT = "transcript";

/** The session workspace `thing` (its own workspace: `workspace === thing`) with its panes. */
export function SessionView(props: ThingViewProps) {
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	// The layout is the person's: it waits for who they are.
	return me?.kind === "person" ? <SessionPanes person={me.id} session={props.thing} /> : null;
}

/** The session's panes, with the layout of person `person`. */
function SessionPanes(props: { readonly session: string; readonly person: string }) {
	const { session } = props;
	const { t } = useMessages(messages);
	const route = useRoute();
	const active = route.kind === "target" && route.target.kind === "workspace" ? route.rest[0] : undefined;
	const Layout = useComponent(PaneLayout);
	const Target = useComponent(TargetView);
	const views = useRegistry(Views);
	const [screen] = useState(randomId);
	const list = useWatch(useLive(useHold(WorkspaceContents, { workspace: session, view: screen }))?.list);
	const things = useMemo(
		() =>
			(list?.rows ?? []).filter(
				(row) => !row.hidden && (views?.get(viewsKey({ kind: "thing", thingKind: row.kind }))?.length ?? 0) > 0,
			),
		[list, views],
	);
	const [tree, setTree] = useLayout(session, props.person);
	const seen = useRef<Set<string> | undefined>(undefined);
	const at = (thing: string | undefined) =>
		targetPath({ kind: "workspace", workspace: session }, thing === undefined ? {} : { rest: [thing] });
	const tidied = list === undefined ? tree : tidiedTree(tree, new Set(things.map(({ thing }) => thing)));
	// biome-ignore lint/correctness/useExhaustiveDependencies: `at` and `setTree` are made anew each render; what they read is listed.
	useEffect(() => {
		if (list === undefined) return;
		let next = tidied;
		// A thing that appears while the page is open opens beside the transcript, without taking the focus; not those
		// the session had when the page first saw it.
		if (seen.current === undefined) seen.current = new Set(things.map(({ thing }) => thing));
		for (const { thing } of things) {
			if (seen.current.has(thing)) continue;
			seen.current.add(thing);
			next = openPane(next, thing, TRANSCRIPT);
		}
		// The route's pane shows in its group; one the session no longer has leaves for the transcript.
		const focus = active ?? TRANSCRIPT;
		if (focus !== TRANSCRIPT && !things.some(({ thing }) => thing === focus)) redirect(at(undefined));
		else if (groupOf(next, focus)?.active !== focus) next = openPane(next, focus, TRANSCRIPT);
		if (!sameTree(next, tree)) setTree(next);
	}, [list, things, tidied, tree, active]);
	const panes: Pane[] = [
		{
			id: TRANSCRIPT,
			title: t("pane"),
			closable: false,
			render: () => <TranscriptPane key={session} session={session} />,
		},
		...things.map(({ thing, name }) => ({
			id: thing,
			title: name,
			closable: true,
			render: () => (
				<div className={styles.paneScroll}>
					{Target === undefined ? null : <Target target={{ kind: "thing", workspace: session, thing }} />}
				</div>
			),
		})),
	];
	return (
		<div className={styles.panes} data-session-view={session}>
			{Layout === undefined ? null : (
				<Layout
					focused={active ?? TRANSCRIPT}
					onChange={setTree}
					onFocus={(pane) => navigate(at(pane === TRANSCRIPT ? undefined : pane))}
					panes={panes}
					tree={tidied}
				/>
			)}
		</div>
	);
}

/**
 * The layout's tree of `session` for person `person` on this device, and its setter: page state first (it survives a
 * reload of this plugin), seeded from the browser's storage (it survives a page load), else the transcript alone.
 * Every change is written to both.
 */
function useLayout(session: string, person: string): readonly [PaneNode, (tree: PaneNode) => void] {
	const key = `p3.session.panes.${person}.${session}`;
	const initial = useMemo(() => storedTree(key) ?? paneTree([TRANSCRIPT]), [key]);
	const [tree, setPageTree] = usePageState<PaneNode>(`session.panes.${person}.${session}`, initial);
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

/** A fresh id for this view's list (its `view`): two pages of one person never share it. */
function randomId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
