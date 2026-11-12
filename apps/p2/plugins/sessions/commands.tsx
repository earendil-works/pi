// The sessions plugin's part of the command menu: New session, Switch session…, and on a session
// target Rename session…, Change working directory… (also on the new-session screen), Archive session and Restore
// session; on a `/tree` branch row's target Rename branch…; New session in folder… and Open folder…; their pages, and
// the sessions the root's query matches by title.
import { BACKGROUND_CONTEXT, withHeld } from "@p2/app/v1";
import {
	ArchiveIcon,
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	FolderIcon,
	FolderMoveIcon,
	FolderPlusIcon,
	getNavigation,
	knownMain,
	ListIcon,
	locationLabel,
	NEW_SESSION,
	navigate,
	openLayer,
	openLayerIn,
	openPage,
	PencilIcon,
	PlusIcon,
	RestoreIcon,
	startNewSession,
	useCommandMatches,
	useCommandMenu,
	useCommandQuery,
	useComposerState,
	useHost,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo, useState } from "react";
import { DIRECTORY_PICKER } from "../envs/contract.web.tsx";
import { branchSheetLayer } from "./BranchSheet.tsx";
import { commandSession, NotArchived, useCommandSession, useSessions } from "./command-session.tsx";
import { type Session, Sessions } from "./contract.ts";
import { FOLDERS, type NewTarget } from "./sidebar/model.ts";
import { usePageData } from "./sidebar/page-data.ts";
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
	"sessions.rename-branch": {
		title: "Rename branch…",
		group: "Branch",
		order: 10,
		icon: PencilIcon,
		keywords: ["label", "name"],
		target: ["branch"],
		owner: true,
		action: { kind: "run", run: renameBranch },
	},
	"sessions.change-directory": {
		title: "Change working directory…",
		group: "Session",
		order: 10,
		icon: FolderMoveIcon,
		keywords: ["cd", "move session", "relocate", "location"],
		target: ["session", "new-session"],
		owner: true,
		Shown: NotArchived,
		action: { kind: "run", run: changeDirectory },
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
	"sessions.new-in-folder": {
		title: "New session in folder…",
		group: "Folder",
		order: 36,
		icon: FolderPlusIcon,
		keywords: ["start session in folder"],
		owner: true,
		action: { kind: "page", page: "new-in-folder" },
	},
	"sessions.open-folder": {
		title: "Open folder…",
		group: "Folder",
		order: 36,
		icon: FolderIcon,
		keywords: ["folder sessions", "list folder"],
		owner: true,
		action: { kind: "page", page: "folders" },
	},
};

/** The pages, by name. */
export const SESSION_PAGES: Readonly<Record<string, CommandPage>> = {
	sessions: { label: "Sessions", placeholder: "Search sessions…", Body: SessionsPage },
	"rename-session": { label: "Rename", placeholder: "New title…", empty: "Type the new title", Body: RenamePage },
	"new-in-folder": { label: "New session", placeholder: "Search folders…", Body: NewInFolderPage },
	folders: { label: "Folders", placeholder: "Search folders…", Body: FoldersPage },
};

/**
 * The sessions the root's query matches, by title, in a group of their own after the commands: a query that names a
 * command ("change model") highlights the command first, one that names only a session shows the session first (no
 * command group has rows). A search group is never targeted, so the targeted command groups come before it anyway;
 * its order is past every command group's (they leave gaps of 10 from 10) so it follows the untargeted ones too.
 */
export const SESSION_SEARCH: CommandSearch = { group: "Sessions", order: 1000, Results: SessionResults };

/**
 * Opens the directory picker over the command's session, else over the new-session screen. The picker is the view's: it
 * starts at the location the view shows and moves the session (as the Session sheet's Working directory row), or sets
 * where the new one starts (as the screen's location).
 */
function changeDirectory(ctx: CommandContext): void {
	const id = commandSession(ctx.target, ctx.route);
	if (id === undefined) openLayer(DIRECTORY_PICKER);
	else openLayerIn(id, id === ctx.route.session ? ctx.route.conversation : knownMain(id), DIRECTORY_PICKER);
}

/** Opens the target branch's rename sheet (the sidebar's `BranchSheet`) over the current route, a phone's drawer too. */
function renameBranch(ctx: CommandContext): void {
	if (ctx.target?.type === "branch") openLayer(branchSheetLayer(ctx.target.id));
}

/** Archives the command's session; the open one gives way to the new-session screen first, as in the Session sheet. */
async function archive(ctx: CommandContext): Promise<void> {
	const id = commandSession(ctx.target, ctx.route);
	if (id === undefined) return;
	await withHeld(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", (catalog) => {
		if (ctx.route.session === id) void getNavigation().replace(NEW_SESSION);
		return catalog.archive({ id }, BACKGROUND_CONTEXT);
	});
}

/** Restores the command's session and opens it, as its archived row in the sidebar does. */
async function restore(ctx: CommandContext): Promise<void> {
	const id = commandSession(ctx.target, ctx.route);
	if (id === undefined) return;
	await withHeld(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", (catalog) =>
		catalog.restore({ id }, BACKGROUND_CONTEXT),
	);
	navigate({ session: id });
}

/** Renders `children` while the command's session is archived. */
function Archived({ children }: { children: ReactNode }) {
	const { session } = useCommandSession();
	return session !== undefined && session.archivedAt !== null ? children : null;
}

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
	const { focusWhenOpen } = useComposerState();
	const open = useRoute().session === session.id;
	return (
		<CommandMenu.Row
			title={session.title}
			suffix={`${folderName(session.env ?? null, session.cwd, 1)} · ${ago(session.updatedAt, now)}`}
			checked={open}
			onSelect={async () => {
				await close();
				// After the close, which gives the focus back to where the menu opened from: the composer takes it from there.
				const target = { session: session.id, conversation: session.main };
				focusWhenOpen(target);
				navigate(target);
			}}
		/>
	);
}

/** The target session's new title is the page's query; its one row renames it. */
function RenamePage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const { session } = useCommandSession();
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

/** A folder sessions work in, as the sidebar's Folders rollup collects it, with when its latest session was active. */
type Folder = {
	readonly key: string;
	readonly name: string;
	readonly target: Extract<NewTarget, { kind: "folder" }>;
	readonly active: number;
};

/** The folders the sidebar knows (its Folders rollup's groups, sessions in view or not), the most recently active first. */
function useFolders(): readonly Folder[] {
	const data = usePageData();
	return useMemo(() => {
		const collected = data?.rollups.find((rollup) => rollup.key === FOLDERS)?.collect(data.rows, data.context);
		if (collected?.layout !== "groups") return [];
		return collected.groups
			.flatMap(({ key, name, target, members }) =>
				target?.kind === "folder"
					? [{ key, name, target, active: Math.max(...members.map((row) => row.updatedAt)) }]
					: [],
			)
			.toSorted((a, b) => b.active - a.active);
	}, [data]);
}

/** What a folder's row says and matches: its name, then where it is. */
const folderPath = (folder: Folder): string => locationLabel(folder.target.env, folder.target.cwd);
const folderText = (folder: Folder): string => `${folder.name} ${folderPath(folder)}`;

/** The folders; picking one opens the new-session screen in it, as its "+" in the sidebar does. */
function NewInFolderPage() {
	const { close } = useCommandMenu();
	const onNewIn = usePageData()?.onNewIn;
	const matches = useCommandMatches(useFolders(), folderText);
	if (!onNewIn) return null;
	return (
		<CommandMenu.Group heading="Folders">
			{matches.map((folder) => (
				<CommandMenu.Row
					key={folder.key}
					title={folder.name}
					suffix={folderPath(folder)}
					onSelect={async () => {
						await close();
						onNewIn(folder.target);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}

/** The folders, the one whose list is open checked; picking one opens its list of sessions in the main area. */
function FoldersPage() {
	const { close } = useCommandMenu();
	const page = useRoute().page;
	const matches = useCommandMatches(useFolders(), folderText);
	return (
		<CommandMenu.Group heading="Folders">
			{matches.map((folder) => (
				<CommandMenu.Row
					key={folder.key}
					title={folder.name}
					suffix={folderPath(folder)}
					checked={folder.key === page}
					onSelect={async () => {
						await close();
						openPage(folder.key);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}
