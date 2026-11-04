// The mobile drawer's component tree, with catalog/status/subagent/search handles supplying its data.

import { Access, BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, liveIn, whenLive } from "@p2/app/v1";
import {
	Drawer,
	navigate,
	openLayer,
	Slot,
	Slots,
	toggleSidebar,
	useComposerState,
	useConnected,
	useHost,
	useNewSessionState,
	useObject,
	useReadable,
	useRoute,
	useStatus,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { Subagents } from "../subagents/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { BranchSheet } from "./BranchSheet.tsx";
import { Sessions } from "./contract.ts";
import { SessionOptions } from "./SessionOptions.tsx";

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

// Explicit mobile ordering.
const footer = (
	<>
		<Slot name="sidebar-foot:providers" />
		<Slot name="sidebar-foot:envs" />
		<Slot name="sidebar-foot:devices" />
		<Slot name="sidebar-foot:ports" />
		<Slot name="sidebar-foot:voice" />
		<Slot name="sidebar-foot:logs" />
	</>
);
function Sidebar() {
	const connected = useConnected();
	const route = useRoute();
	const service = useObject(Sessions, {});
	const catalog = liveIn(service, "owner");
	const access = useObject(Access, {});
	const guest = useReadable(liveIn(access, "guest")?.grant);
	const owner = useStatus(access) === "live" && access?.variant === "owner";
	const status = liveIn(useObject(SessionStatus, {}), "reader");
	const agents = liveIn(useObject(Subagents, {}), "reader");
	const list = useReadable(liveIn(service, "owner", "guest")?.sessions);
	const statuses = useReadable(status?.statuses);
	const children = useReadable(agents?.children);
	// Unread answers are the owner's (any device); guests see none and mark nothing.
	const marks = useObject(SessionReads, owner ? {} : undefined);
	const answers = useReadable(marks?.answers);
	const reads = useReadable(marks?.reads);
	const sessions = useMemo(
		() =>
			(list ?? []).map((session) => {
				const busy = statuses?.[session.id]?.busy ?? [];
				return {
					...session,
					env: session.env ?? null,
					worker: {
						busy,
						error: statuses?.[session.id]?.error,
						unread: (answers?.[session.id] ?? 0) > (reads?.[session.id] ?? 0),
					},
					subagents: children?.[session.id] ?? [],
				};
			}),
		[list, statuses, children, answers, reads],
	);
	// The open session's main conversation, shown on a visible page, is read through its latest answer.
	const visible = usePageVisible();
	const shownMain = (list ?? []).find((session) => session.id === route.session)?.main;
	const shown = visible && route.conversation === shownMain ? route.session : undefined;
	const latest = shown ? (answers?.[shown] ?? 0) : 0;
	const read = shown ? (reads?.[shown] ?? 0) : 0;
	useEffect(() => {
		if (shown && marks && latest > read)
			void marks.markRead({ session: shown, through: latest }, BACKGROUND_CONTEXT).catch(() => {});
	}, [marks, shown, latest, read]);
	const search = useObject(Search, owner ? {} : undefined);
	const onSearch = useCallback(
		(query: string, archived: boolean) => search!.search({ query, archived }, BACKGROUND_CONTEXT),
		[search],
	);
	const onRestore = useCallback(
		(id: string) =>
			catalog?.restore({ id }, BACKGROUND_CONTEXT) ?? Promise.reject(new Error("Only the owner restores sessions")),
		[catalog],
	);
	// A session opens at its main conversation; `/s/<id>` would open conversation 1, which redirects there.
	const onOpen = useCallback(
		(session: string, conversation?: number) =>
			navigate({ session, conversation: conversation ?? list?.find((each) => each.id === session)?.main ?? 1 }),
		[list],
	);
	// A branch's switch or rename: a reference of its own (the change also reaches the session row).
	const host = useHost();
	const withTree = useCallback(
		(session: string, action: (tree: HeldIn<typeof SessionTree, "owner">) => Promise<unknown>) => {
			const held = host.hold(SessionTree, { session }, BACKGROUND_CONTEXT);
			return whenLive(held)
				.then(() => {
					const tree = liveIn(held, "owner");
					if (!tree) throw new Error("Only the owner changes branches");
					return action(tree);
				})
				.finally(() => held.release());
		},
		[host],
	);
	// Errors go to the app's toast in main, as in Pi Mobile (not clipped inside the drawer).
	const { setError } = useComposerState();
	const onBranch = useCallback(
		(session: string, conversation: number) =>
			void withTree(session, (tree) => tree.select({ conversation }, BACKGROUND_CONTEXT))
				.then(() => navigate({ session, conversation }))
				.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))),
		[withTree, setError],
	);
	const [renaming, setRenaming] = useState<{ session: string; conversation: number }>();
	const onRenameBranch = useCallback(
		(session: string, conversation: number) => setRenaming({ session, conversation }),
		[],
	);
	const renamed = renaming && list?.find((each) => each.id === renaming.session);
	const branch = renamed?.branches.find((each) => each.conversation === renaming?.conversation);
	const { setChoice } = useNewSessionState();
	const onNew = useCallback(() => {
		setChoice(undefined);
		navigate({});
		setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
	}, [setChoice]);
	return (
		<>
			<Drawer
				sessions={sessions}
				guest={guest}
				activeId={route.session}
				conversationId={route.conversation}
				connected={connected}
				onOpen={onOpen}
				onBranch={owner ? onBranch : undefined}
				onRenameBranch={owner ? onRenameBranch : undefined}
				onNew={onNew}
				onCollapse={toggleSidebar}
				onSearch={search ? onSearch : undefined}
				onRestore={onRestore}
				onError={setError}
				footer={footer}
				onProviders={() => openLayer({ kind: "sheet", name: "providers" }, { fromDrawer: true })}
				onEnvs={() => openLayer({ kind: "sheet", name: "envs" }, { fromDrawer: true })}
				onOwnerLink={() => openLayer({ kind: "sheet", name: "devices" }, { fromDrawer: true })}
			/>
			{renamed && branch && (
				<BranchSheet
					title={renamed.title}
					conversation={branch.conversation}
					label={branch.label}
					onSave={(label) =>
						withTree(renamed.id, (tree) =>
							tree.rename({ conversation: branch.conversation, label }, BACKGROUND_CONTEXT),
						)
					}
					onClose={() => setRenaming(undefined)}
				/>
			)}
		</>
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-sessions", (self) => {
		self.contribute(Slots, { sidebar: Sidebar, "session-options": SessionOptions });
	});
});
