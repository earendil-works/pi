// The sessions plugin's part of the command menu: New session, Switch session…, and on a session
// target Rename session…, Archive session and Restore session; the sessions page, the rename page, and the sessions the
// root's query matches by title.
import { BACKGROUND_CONTEXT, keptIn, withHeld } from "@p2/app/v1";
import {
	ArchiveIcon,
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	getNavigation,
	ListIcon,
	NEW_SESSION,
	navigate,
	PencilIcon,
	PlusIcon,
	RestoreIcon,
	startNewSession,
	useCommandMatches,
	useCommandMenu,
	useCommandQuery,
	useCommandTarget,
	useComposerState,
	useHost,
	useObject,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo, useState } from "react";
import { type Session, Sessions } from "./contract.ts";
import { ago, folderName } from "./sidebar/Row.tsx";

/** The commands, by id. */
export const SESSION_COMMANDS: Readonly<Record<string, Command>> = {
	"sessions.new": {
		title: "New session",
		group: "Session",
		order: 10,
		icon: PlusIcon,
		owner: true,
		action: { kind: "run", run: () => startNewSession() },
	},
	"sessions.switch": {
		title: "Switch session…",
		group: "Session",
		order: 10,
		icon: ListIcon,
		keywords: ["open session", "go to session"],
		action: { kind: "page", page: "sessions" },
	},
	"sessions.rename": {
		title: "Rename session…",
		group: "Session",
		order: 10,
		icon: PencilIcon,
		target: ["session"],
		owner: true,
		action: { kind: "page", page: "rename-session" },
	},
	"sessions.archive": {
		title: "Archive session",
		group: "Session",
		order: 10,
		icon: ArchiveIcon,
		keywords: ["delete", "remove"],
		target: ["session"],
		owner: true,
		Shown: NotArchived,
		action: { kind: "run", run: archive },
	},
	"sessions.restore": {
		title: "Restore session",
		group: "Session",
		order: 10,
		icon: RestoreIcon,
		keywords: ["unarchive"],
		target: ["session"],
		owner: true,
		Shown: Archived,
		action: { kind: "run", run: restore },
	},
};

/** The pages, by name. */
export const SESSION_PAGES: Readonly<Record<string, CommandPage>> = {
	sessions: { label: "Sessions", placeholder: "Search sessions…", Body: SessionsPage },
	"rename-session": { label: "Rename", placeholder: "New title…", empty: "Type the new title", Body: RenamePage },
};

/**
 * The sessions the root's query matches, by title, in a group of their own after the commands: a query that names a
 * command ("change model") highlights the command first, one that names only a session shows the session first (no
 * command group has rows). A search group is never targeted, so the targeted command groups come before it anyway;
 * its order is past every command group's (they leave gaps of 10 from 10) so it follows the untargeted ones too.
 */
export const SESSION_SEARCH: CommandSearch = { group: "Sessions", order: 1000, Results: SessionResults };

/** The session a command acts on: the target's, when it is a session (a shortcut may run a command without one). */
const targetSession = (target: CommandContext["target"]): string | undefined =>
	target?.type === "session" ? target.id : undefined;

/** Archives the target session; the open one gives way to the new-session screen first, as in the Session sheet. */
async function archive(ctx: CommandContext): Promise<void> {
	const id = targetSession(ctx.target);
	if (id === undefined) return;
	await withHeld(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", (catalog) => {
		if (ctx.route.session === id) void getNavigation().replace(NEW_SESSION);
		return catalog.archive({ id }, BACKGROUND_CONTEXT);
	});
}

/** Restores the target session and opens it, as its archived row in the sidebar does. */
async function restore(ctx: CommandContext): Promise<void> {
	const id = targetSession(ctx.target);
	if (id === undefined) return;
	await withHeld(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", (catalog) =>
		catalog.restore({ id }, BACKGROUND_CONTEXT),
	);
	navigate({ session: id });
}

/** Renders `children` while the target session is not archived. */
function NotArchived({ children }: { children: ReactNode }) {
	const session = useTargetSession();
	return session?.archivedAt === null ? children : null;
}

/** Renders `children` while the target session is archived. */
function Archived({ children }: { children: ReactNode }) {
	const session = useTargetSession();
	return session !== undefined && session.archivedAt !== null ? children : null;
}

/** The target session's catalog row, as the sidebar shows it (kept while reconnecting). */
function useTargetSession(): Session | undefined {
	const id = targetSession(useCommandTarget());
	return useSessions()?.find((session) => session.id === id);
}

/** The catalog's rows the reader sees: every session for the owner, its own for a guest. */
const useSessions = (): readonly Session[] | undefined =>
	useReadable(keptIn(useObject(Sessions, {}), "owner", "guest")?.sessions);

/** The sessions that are not archived, the most recently active first. */
function useOpenSessions(): readonly Session[] {
	const sessions = useSessions();
	return useMemo(
		() =>
			(sessions ?? [])
				.filter((session) => session.archivedAt === null)
				.toSorted((a, b) => b.updatedAt - a.updatedAt),
		[sessions],
	);
}

const titleOf = (session: Session): string => session.title;

/** Every session that is not archived, the most recent first; picking one opens it. */
function SessionsPage() {
	const matches = useCommandMatches(useOpenSessions(), titleOf);
	const [now] = useState(Date.now);
	return (
		<CommandMenu.Group heading="Sessions">
			{matches.map((session) => (
				<SessionRow key={session.id} session={session} now={now} />
			))}
		</CommandMenu.Group>
	);
}

/** How many sessions the root's results show: the best matches; the sessions page has the rest. */
const SEARCH_ROWS = 5;

/** The sessions matching the root's query (it is never empty here: searches mount only while the reader types). */
function SessionResults() {
	const matches = useCommandMatches(useOpenSessions(), titleOf);
	const [now] = useState(Date.now);
	return matches.slice(0, SEARCH_ROWS).map((session) => <SessionRow key={session.id} session={session} now={now} />);
}

/**
 * A session: its title, its folder and how long ago it was active, checked while it is the open one (where the reader
 * is); it opens at its main conversation.
 */
function SessionRow({ session, now }: { session: Session; now: number }) {
	const { close } = useCommandMenu();
	const open = useRoute().session === session.id;
	return (
		<CommandMenu.Row
			title={session.title}
			suffix={`${folderName(session.env ?? null, session.cwd, 1)} · ${ago(session.updatedAt, now)}`}
			checked={open}
			onSelect={async () => {
				await close();
				navigate({ session: session.id, conversation: session.main });
			}}
		/>
	);
}

/** The target session's new title is the page's query; its one row renames it. */
function RenamePage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const session = useTargetSession();
	const title = useCommandQuery().trim();
	if (!session || title === "" || title === session.title) return null;
	return (
		<CommandMenu.Group heading="Session">
			<CommandMenu.Row
				title={`Rename to “${title}”`}
				icon={PencilIcon}
				onSelect={async () => {
					await close();
					await withHeld(host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", (catalog) =>
						catalog.rename({ id: session.id, title }, BACKGROUND_CONTEXT),
					).catch(fail);
				}}
			/>
		</CommandMenu.Group>
	);
}
