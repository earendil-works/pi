// The tree panel (docs/tree.md, "Tree panel"): the session's turns in every branch as a table of contents in the side
// panel (Elanor's), oldest first as the transcript beside it reads, the current branch at the top level and the other
// branches inset under the turn they were forked after (toc.ts builds it). Its indicator follows the turn in view in
// the transcript. It only moves through the tree: choosing a turn shows it in the transcript, switching the session to
// the branch storing it first when that is not the current one. Editing and branching happen in the transcript. A
// branch's label is the command menu's target for it (hovered or focused, or a long press on touch): "Rename branch…".
import { BACKGROUND_CONTEXT, type HeldIn, liveIn } from "@p2/app/v1";
import {
	closePanel,
	conversationRoute,
	errorText,
	requestReveal,
	SidePanel,
	TableOfContents,
	useCommandMenuRow,
	useComposerState,
	useNavigation,
	useObject,
	useReadable,
	useWide,
} from "@p2/app/v1/web";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Sessions } from "../sessions/contract.ts";
import { branchTarget } from "./branch-target.ts";
import { SessionTree, type Tree, type TreeNode } from "./contract.ts";
import { onReaderScroll, useEntryInView } from "./entry-in-view.ts";
import { type Tip, type Toc, type Turn, tableOfContents } from "./toc.ts";
import "./tree.css";

/** The side panel's name in the route (`Route.panel`). */
export const TREE_PANEL = "tree";

type Loaded = { readonly kind: "tree"; readonly tree: Tree } | { readonly kind: "failed"; readonly error: string };

/** The panel for the session `session`: its tree, read again whenever the session row says it changed. */
export function TreePanel({ session }: { session: string }) {
	const tree = useObject(SessionTree, { session }, { variant: "owner" });
	const rows = useReadable(liveIn(useObject(Sessions, {}), "owner", "guest")?.sessions);
	const row = rows?.find((each) => each.id === session);
	// What changes the tree: a new message (the row's activity time), a switch, a new or renamed branch. Reading the tree
	// scans the session's history, so it runs on these changes only, not per streamed part.
	const stamp = row && `${row.main}:${row.updatedAt}:${JSON.stringify(row.branches)}`;
	const [loaded, setLoaded] = useState<Loaded>();
	useEffect(() => {
		if (!tree || stamp === undefined) return;
		let shown = true;
		tree.tree(BACKGROUND_CONTEXT).then(
			(value) => shown && setLoaded({ kind: "tree", tree: value }),
			(error: unknown) => shown && setLoaded({ kind: "failed", error: errorText(error) }),
		);
		return () => {
			shown = false;
		};
	}, [tree, stamp]);
	const toc = useMemo(() => (loaded?.kind === "tree" ? tableOfContents(loaded.tree) : undefined), [loaded]);
	const branches = loaded?.kind === "tree" ? loaded.tree.branches.length : 0;
	return (
		<SidePanel
			title="Tree"
			meta={branches > 1 ? `${branches} branches` : undefined}
			onClose={closePanel}
			className="tree-panel"
			testId="tree-panel"
		>
			{loaded?.kind === "failed" ? (
				<p className="empty-note">{loaded.error}</p>
			) : !toc || loaded?.kind !== "tree" ? (
				<p className="empty-note">Loading…</p>
			) : toc.turns.length === 0 && toc.detached.length === 0 ? (
				<p className="empty-note">No messages yet.</p>
			) : (
				<TreeContents held={tree} session={session} title={row?.title ?? ""} tree={loaded.tree} toc={toc} />
			)}
		</SidePanel>
	);
}

/** What a turn's item does: show the turn in the transcript, on the branch storing it. */
type TurnActions = {
	readonly session: string;
	readonly title: string;
	readonly pending: boolean;
	readonly active: number | undefined;
	jump(turn: Turn): void;
};

/** The table of contents, its indicator on the turn in view in the main conversation's transcript. */
function TreeContents({
	held,
	session,
	title,
	tree,
	toc,
}: {
	held: HeldIn<typeof SessionTree, "owner"> | undefined;
	session: string;
	title: string;
	tree: Tree;
	toc: Toc;
}) {
	const nav = useNavigation();
	const wide = useWide();
	const { fail } = useComposerState();
	const [pending, setPending] = useState(false);
	const inMain = nav.route.conversation === tree.main;
	const inView = useEntryInView(tree);
	// The turn chosen last, marked until the reader scrolls the transcript: the reveal cannot bring a turn near the
	// transcript's end up to the reading line, so the turn in view would be an earlier one.
	const [chosen, setChosen] = useState<number>();
	useEffect(() => (chosen === undefined ? undefined : onReaderScroll(() => setChosen(undefined))), [chosen]);
	// The turn in view: the last turn of the current branch starting at or before the entry in view.
	const active =
		inMain && inView !== undefined ? toc.turns.findLast((turn) => firstOf(turn).entry <= inView) : undefined;
	const root = useRef<HTMLElement>(null);
	const activeKey = chosen ?? (active && firstOf(active).entry);
	useEffect(() => {
		if (activeKey !== undefined)
			root.current?.querySelector(`[data-turn="${activeKey}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeKey]);
	// Opens a conversation of the session at a turn; on phones the panel, a sheet over the chat, closes.
	const show = (conversation: number, entry: number) => {
		requestReveal(session, conversation, entry);
		if (wide && nav.route.conversation === conversation) return;
		const next = conversationRoute(nav.route, session, conversation);
		void nav.replace(wide ? next : { ...next, panel: undefined });
	};
	const actions: TurnActions = {
		session,
		title,
		pending,
		active: activeKey,
		jump: (turn) => {
			const { entry, conversation } = firstOf(turn);
			if (pending) return;
			setChosen(entry);
			// A turn of the current branch is in the main conversation's transcript, inherited ones included.
			if (turn.current) return show(tree.main, entry);
			if (!held) return fail(new Error("The tree is not available"));
			// Another branch's turn: the session switches to the branch storing it, which ends where that branch ends.
			setPending(true);
			held
				.select({ conversation }, BACKGROUND_CONTEXT)
				.then(() => show(conversation, entry))
				.catch((error: unknown) => {
					setChosen(undefined);
					fail(error);
				})
				.finally(() => setPending(false));
		},
	};
	return (
		<TableOfContents.Root
			ref={root}
			className="tree-toc"
			aria-label="Conversation tree, oldest first"
			aria-busy={pending || undefined}
		>
			{toc.detached.length > 0 && (
				<TableOfContents.List className="tree-detached">
					<TableOfContents.Item>
						<span className="tree-note">Started before the first message</span>
						{toc.detached.map((chain) => (
							<TurnList key={chain.start} turns={chain.turns} actions={actions} />
						))}
					</TableOfContents.Item>
				</TableOfContents.List>
			)}
			<TurnList turns={toc.turns} actions={actions} />
			<TableOfContents.Indicator />
		</TableOfContents.Root>
	);
}

/** A turn's first message (the transcript's order): its key, and the branch storing it. */
function firstOf(turn: Turn): TreeNode {
	return turn.messages.kind === "exchange" ? turn.messages.user : turn.messages.answer;
}

/** A chain of turns: the current branch at the top level, a branch nested under the turn it was forked after. */
function TurnList({ turns, actions }: { turns: readonly Turn[]; actions: TurnActions }) {
	return (
		<TableOfContents.List>
			{turns.map((turn) => (
				<TurnItem key={firstOf(turn).entry} turn={turn} actions={actions} />
			))}
		</TableOfContents.List>
	);
}

/** One turn: its message and answer, the branches ending at it; then its branches. */
function TurnItem({ turn, actions }: { turn: Turn; actions: TurnActions }) {
	const key = firstOf(turn).entry;
	const { messages } = turn;
	const user = messages.kind === "exchange" ? messages.user : null;
	const answer = messages.answer;
	return (
		<TableOfContents.Item className={turn.current ? "current" : "inset"}>
			<TableOfContents.Link
				href={`#turn-${key}`}
				active={actions.active === key}
				data-turn={key}
				title={turn.current ? undefined : "Switch the session to this branch and show this message"}
				onClick={(event: MouseEvent) => {
					// A choice in the panel, not an address.
					event.preventDefault();
					actions.jump(turn);
				}}
			>
				<span className="tree-line">
					{turn.tips.map((tip) => (
						<BranchLabel key={tip.conversation} session={actions.session} tip={tip} title={actions.title} />
					))}
					<span className="tree-text" data-role={user ? "user" : "assistant"}>
						{(user ?? answer)?.text}
					</span>
				</span>
				{user && answer && <span className="tree-answer">{answer.text}</span>}
			</TableOfContents.Link>
			{turn.branches.map((chain) => (
				<TurnList key={chain.start} turns={chain.turns} actions={actions} />
			))}
		</TableOfContents.Item>
	);
}

/** A branch's label at its last turn ("Current: …" on the main one), the command menu's target for the branch. */
function BranchLabel({ session, tip, title }: { session: string; tip: Tip; title: string }) {
	const label = tip.label ?? title;
	const target = useCommandMenuRow(branchTarget({ session, conversation: tip.conversation }, label));
	return (
		<span className={`tree-ref ${tip.main ? "main" : ""}`} {...target}>
			{tip.main ? "Current: " : ""}
			{label}
		</span>
	);
}
