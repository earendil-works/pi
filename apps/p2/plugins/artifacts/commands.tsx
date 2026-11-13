// The artifacts plugin's part of the command menu, for the open session: Open artifact… (while it has items) with the
// page listing every artifact kind's items (ArtifactKinds), and the items the root's query matches by title. Picking
// one opens it as a view beside the chat, or for a reader in the side panel, as the side panel's rows do.
import { BACKGROUND_CONTEXT, liveIn, withHeld } from "@p2/app/v1";
import {
	ArtifactIcon,
	type ArtifactItem,
	type ArtifactKind,
	ArtifactKinds,
	type Command,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	openPanel,
	useCommandMatches,
	useCommandMenu,
	useCommandTarget,
	useComposerState,
	useHost,
	useObject,
	useRegistry,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useEffect, useState } from "react";
import { Views } from "../views/contract.ts";
import { ViewsPages } from "../views/contract.web.ts";
import { PANEL, showLocally } from "./local-item.ts";

/** The commands, by id. */
export const ARTIFACT_COMMANDS: Readonly<Record<string, Command>> = {
	"artifacts.open": {
		title: "Open artifact…",
		group: "Artifacts",
		order: 50,
		icon: ArtifactIcon,
		keywords: ["show artifacts", "view artifact"],
		target: ["session"],
		Shown: HasItems,
		action: { kind: "page", page: "artifacts" },
	},
};

/** The pages, by name. */
export const ARTIFACT_PAGES: Readonly<Record<string, CommandPage>> = {
	artifacts: {
		label: "Artifacts",
		placeholder: "Search artifacts…",
		empty: "No artifacts in this session",
		Body: ArtifactsPage,
	},
};

/** The items the root's query matches, in the Artifacts group. */
export const ARTIFACT_SEARCH: CommandSearch = { group: "Artifacts", order: 1010, Results: ArtifactResults };

/** How many items the root's results show: the best matches; the page has the rest. */
const SEARCH_ROWS = 5;

/** The open session the menu's target is, if it is one (artifacts open as views beside its chat). */
function useSession(): string | undefined {
	const target = useCommandTarget();
	const session = useRoute().session;
	return target?.type === "session" && target.id === session ? session : undefined;
}

/** Renders `children` while the open session has items. */
function HasItems({ children }: { children: ReactNode }) {
	const session = useSession();
	if (session === undefined) return null;
	return <Counted session={session}>{children}</Counted>;
}

/** Renders `children` while `session` has items of some kind. */
function Counted({ session, children }: { session: string; children: ReactNode }) {
	const { entries, collectors } = useEntries(session);
	return (
		<>
			{collectors}
			{entries.length > 0 && children}
		</>
	);
}

/** One kind's item, with what opens it. */
type Entry = { readonly kind: ArtifactKind; readonly item: ArtifactItem };

const textOf = (entry: Entry): string => `${entry.item.title} ${entry.item.id} ${entry.kind.title}`;

/** Every kind's items of `session`, the newest first (each kind's hook in a component of its own). */
function useEntries(session: string): { entries: readonly Entry[]; collectors: ReactNode } {
	const kinds = useRegistry(ArtifactKinds);
	const [found, setFound] = useState<Record<string, readonly Entry[]>>({});
	const collectors = [...kinds].map(([name, kind]) => (
		<Collect
			key={`${session}:${name}`}
			session={session}
			kind={kind}
			onItems={(entries) => setFound((before) => ({ ...before, [name]: entries }))}
		/>
	));
	const entries = Object.values(found)
		.flat()
		.sort((a, b) => b.item.updated - a.item.updated);
	return { entries, collectors };
}

/** Reports one kind's items. */
function Collect({
	session,
	kind,
	onItems,
}: {
	session: string;
	kind: ArtifactKind;
	onItems: (entries: readonly Entry[]) => void;
}) {
	const items = kind.useItems(session);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reports when the items change, not when the callback does.
	useEffect(() => onItems((items ?? []).map((item) => ({ kind, item }))), [items, kind]);
	return null;
}

/** Every item; picking one opens it as a view. */
function ArtifactsPage() {
	const session = useSession();
	if (session === undefined) return null;
	return <Rows session={session} limit={undefined} />;
}

/** The best matches of the root's query. */
function ArtifactResults() {
	const session = useSession();
	if (session === undefined) return null;
	return <Rows session={session} limit={SEARCH_ROWS} />;
}

/** The matching items of `session`, at most `limit`. */
function Rows({ session, limit }: { session: string; limit: number | undefined }) {
	const host = useHost();
	const editor = liveIn(useObject(Views, { session }), "editor");
	const viewsPage = useRegistry(ViewsPages).get("views");
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const { entries, collectors } = useEntries(session);
	const matches = useCommandMatches(entries, textOf).slice(0, limit);
	return (
		<>
			{collectors}
			{matches.length > 0 && (
				<CommandMenu.Group heading="Artifacts">
					{matches.map(({ kind, item }) => (
						<CommandMenu.Row
							key={`${kind.view}:${item.id}`}
							title={item.title}
							icon={kind.icon}
							suffix={kind.title}
							onSelect={async () => {
								await close();
								// A reader who may not change the session's views looks at it in the side panel.
								if (!editor || !viewsPage) {
									showLocally(session, { kind: kind.view, id: item.id, title: item.title });
									openPanel(PANEL);
									return;
								}
								await withHeld(host.hold(Views, { session }, BACKGROUND_CONTEXT), "editor", (held) =>
									viewsPage.open(held, session, {
										kind: kind.view,
										item: item.id,
										title: item.title.slice(0, 120),
									}),
								).catch(fail);
							}}
						/>
					))}
				</CommandMenu.Group>
			)}
		</>
	);
}
