// The mobile drawer's component tree, with catalog/status/subagent/search handles supplying its data.

import { Access, BACKGROUND_CONTEXT, contribute, defineFacet, liveIn } from "@p2/app/v1";
import {
	Drawer,
	navigate,
	openLayer,
	Slot,
	Slots,
	toggleSidebar,
	useComposerState,
	useConnected,
	useNewSessionState,
	useObject,
	useReadable,
	useRoute,
	useStatus,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { Subagents } from "../subagents/contract.ts";
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
	// The open session's root conversation, shown on a visible page, is read through its latest answer.
	const visible = usePageVisible();
	const shown = visible && (route.conversation ?? 1) === 1 ? route.session : undefined;
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
	const onOpen = useCallback((session: string, conversation = 1) => navigate({ session, conversation }), []);
	const { setChoice } = useNewSessionState();
	const onNew = useCallback(() => {
		setChoice(undefined);
		navigate({});
		setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
	}, [setChoice]);
	// Errors go to the app's toast in main, as in Pi Mobile (not clipped inside the drawer).
	const { setError } = useComposerState();
	return (
		<Drawer
			sessions={sessions}
			guest={guest}
			activeId={route.session}
			conversationId={route.conversation}
			connected={connected}
			onOpen={onOpen}
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
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-sessions", (self) => {
		self.contribute(Slots, { sidebar: Sidebar, "session-options": SessionOptions });
	});
});
