// The sessions plugin's part of the command menu: New session…, Switch session…, and on a session target Rename
// session…, Change working directory… (also on the new-session screen), Archive session and Restore session; the
// sidebar items' actions, for touch screens without their hover button: Stop run (a session's or a subagent's) and
// Archive subagent; on a `/tree` branch's target Rename branch…; Open folder…; their pages, and the sessions the root's
// query matches by title.
import { BACKGROUND_CONTEXT, withGranted } from "@p2/app/v1";
import {
	ArchiveIcon,
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	type CommandSearch,
	type CommandTarget,
	FolderIcon,
	FolderMoveIcon,
	getNavigation,
	knownMain,
	ListIcon,
	NEW_SESSION,
	type NewSessionLocation,
	navigate,
	openLayer,
	openLayerIn,
	openPage,
	PencilIcon,
	PlusIcon,
	RestoreIcon,
	StopIcon,
	shortPath,
	startNewSession,
	useCommandMatches,
	useCommandMenu,
	useCommandQuery,
	useCommandTarget,
	useComposerState,
	useHost,
	useNewSessionState,
	useRoute,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo, useState } from "react";
import { conversationOf } from "../chat/contract.ts";
import { DIRECTORY_PICKER, directoryPickerLayer } from "../envs/contract.web.tsx";
import { stoppable } from "./agent-actions.ts";
import { branchSheetLayer } from "./BranchSheet.tsx";
import { commandSession, NotArchived, useCommandSession, useOpenFromMenu, useSessions } from "./command-session.tsx";
import { SESSIONS_OWNER, type Session, Sessions } from "./contract.ts";
import { FOLDER_ROLLUP, folderKey, type NewTarget } from "./sidebar/model.ts";
import { type PageData, pageData, usePageData } from "./sidebar/page-data.ts";
import { ago, folderName } from "./sidebar/Row.tsx";

/** The commands, by id. */
export const SESSION_COMMANDS: Readonly<Record<string, Command>> = {
	"sessions.new": {
		title: "New session…",
		group: "Session",
		order: 10,
		icon: PlusIcon,
		keywords: ["start session in folder", "new session in folder"],
		owner: true,
		action: { kind: "page", page: "new-session" },
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
	"sessions.stop": {
		title: "Stop run",
		group: "Session",
		order: 10,
		icon: StopIcon,
		keywords: ["cancel", "abort", "interrupt"],
		target: ["session", "conversation"],
		Shown: Running,
		action: { kind: "run", run: stop },
	},
	"sessions.archive-subagent": {
		title: "Archive subagent",
		group: "Conversation",
		order: 15,
		icon: ArchiveIcon,
		keywords: ["remove", "hide"],
		target: ["conversation"],
		Shown: Archivable,
		action: { kind: "run", run: archiveAgent },
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
	"new-session": { label: "New session", placeholder: "Search folders…", Body: NewSessionPage },
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
	await withGranted(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), SESSIONS_OWNER, (catalog) => {
		if (ctx.route.session === id) void getNavigation().replace(NEW_SESSION);
		return catalog.archive({ id }, BACKGROUND_CONTEXT);
	});
}

/** Restores the command's session and opens it, as its archived row in the sidebar does. */
async function restore(ctx: CommandContext): Promise<void> {
	const id = commandSession(ctx.target, ctx.route);
	if (id === undefined) return;
	await withGranted(ctx.host.hold(Sessions, {}, BACKGROUND_CONTEXT), SESSIONS_OWNER, (catalog) =>
		catalog.restore({ id }, BACKGROUND_CONTEXT),
	);
	navigate({ session: id });
}

/**
 * The runs a command's target stops, as its item's Cancel does (the sidebar's data: `stoppable`): a session's running
 * conversations, or a subagent's; none when the reader may not stop them.
 */
function runsOf(data: PageData | undefined, target: CommandTarget | undefined): RunsOf | undefined {
	const at = target?.type === "conversation" ? conversationOf(target.id) : undefined;
	const session = target?.type === "session" ? target.id : at?.session;
	const row = session === undefined ? undefined : data?.rows.find((each) => each.id === session);
	if (!data || !row || !data.writable(row.id)) return undefined;
	const conversations = at
		? row.worker.busy.filter((conversation) => conversation === at.conversation)
		: stoppable(row.worker.busy, row.subagents);
	return conversations.length > 0 ? { data, session: row.id, conversations } : undefined;
}

type RunsOf = { readonly data: PageData; readonly session: string; readonly conversations: readonly number[] };

function stop(ctx: CommandContext): void {
	const runs = runsOf(pageData(), ctx.target);
	runs?.data.onCancel(runs.session, runs.conversations);
}

/** Renders `children` while the command's target runs and the reader may stop it. */
function Running({ children }: { children: ReactNode }) {
	return runsOf(usePageData(), useCommandTarget()) ? children : null;
}

/** The subagent a command's target names, when the reader may archive it (not a one-shot agent, not archived yet). */
function archivableOf(data: PageData | undefined, target: CommandTarget | undefined) {
	const at = target?.type === "conversation" ? conversationOf(target.id) : undefined;
	const row = at && data?.rows.find((each) => each.id === at.session);
	const agent = row?.subagents.find((each) => each.conversationId === at?.conversation);
	return data && at && agent && agent.kind !== "agent" && !agent.archived && data.writable(at.session)
		? { data, ...at }
		: undefined;
}

function archiveAgent(ctx: CommandContext): void {
	const agent = archivableOf(pageData(), ctx.target);
	agent?.data.onArchiveAgent(agent.session, agent.conversation);
}

/** Renders `children` while the command's target is a subagent the reader may archive. */
function Archivable({ children }: { children: ReactNode }) {
	return archivableOf(usePageData(), useCommandTarget()) ? children : null;
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
	const open = useOpenFromMenu();
	const shown = useRoute().session === session.id;
	return (
		<CommandMenu.Row
			title={session.title}
			suffix={`${folderName(session.env ?? null, session.cwd, 1)} · ${ago(session.updatedAt, now)}`}
			checked={shown}
			onSelect={() => open({ session: session.id, conversation: session.main })}
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
					await withGranted(host.hold(Sessions, {}, BACKGROUND_CONTEXT), SESSIONS_OWNER, (catalog) =>
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
	readonly target: Extract<NewTarget, { kind: "folder" }>;
	readonly active: number;
};

/** The folders sessions work in (`FOLDER_ROLLUP`'s groups, sessions in view or not), the most recently active first. */
function useFolders(): readonly Folder[] {
	const data = usePageData();
	return useMemo(() => {
		const collected = data && FOLDER_ROLLUP.collect(data.rows, data.context);
		if (collected?.layout !== "groups") return [];
		return collected.groups
			.flatMap(({ key, target, members }) =>
				target?.kind === "folder"
					? [{ key, target, active: Math.max(...members.map((row) => row.updatedAt)) }]
					: [],
			)
			.toSorted((a, b) => b.active - a.active);
	}, [data]);
}

/** A folder row's title: the folder's own name. */
const folderTitle = (folder: Folder): string => folderName(null, folder.target.cwd, 1);

/** What a folder's row says after its name, and nothing twice: the machine, and the folder it is in. */
function folderWhere(folder: Folder): string {
	const path = shortPath(folder.target.cwd);
	const parent = path.split(/[\\/]/).slice(0, -1).join("/");
	const machine = folder.target.env ?? "This device";
	return parent ? `${machine} · ${parent}` : machine;
}

const folderText = (folder: Folder): string => `${folderTitle(folder)} ${folderWhere(folder)} ${folder.target.cwd}`;

/** New session…: picking a folder opens the new-session screen there; Select folder… opens it with the picker over it. */
function NewSessionPage() {
	return (
		<StartFolders
			choose={(location) => startNewSession({ location })}
			browse={(location) => startNewSession({ location, layer: directoryPickerLayer(location.env, location.cwd) })}
		/>
	);
}

/** The browse row, matched by what it does. */
const SELECT_FOLDER = ["Select folder… browse directory"];
const selectText = (text: string): string => text;

/**
 * Where a new session can start: Select folder… (the directory picker), then the folders sessions work in, the most
 * recently active first, with the current one (`useCurrentFolder`) at their top, checked and highlighted first. Both
 * callbacks run once the menu closed.
 */
function StartFolders({
	choose,
	browse,
}: {
	choose: (location: NewSessionLocation) => void;
	browse: (location: NewSessionLocation) => void;
}) {
	const { close } = useCommandMenu();
	const current = useCurrentFolder();
	const known = useFolders();
	const folders = useMemo(() => withCurrent(known, current), [known, current]);
	const matches = useCommandMatches(folders, folderText);
	const select = useCommandMatches(SELECT_FOLDER, selectText);
	const first = folders[0];
	return (
		<>
			{select.length > 0 && (
				<CommandMenu.Group heading="Browse">
					<CommandMenu.Row
						title="Select folder…"
						icon={FolderMoveIcon}
						onSelect={async () => {
							await close();
							browse(first ? locationOf(first) : { env: null, cwd: "~" });
						}}
					/>
				</CommandMenu.Group>
			)}
			<CommandMenu.Group heading="Recent folders">
				{matches.map((folder) => (
					<CommandMenu.Row
						key={folder.key}
						title={folderTitle(folder)}
						icon={FolderIcon}
						suffix={folderWhere(folder)}
						checked={current !== undefined && sameFolder(folder, current)}
						preferred={folder === first}
						onSelect={async () => {
							await close();
							choose(locationOf(folder));
						}}
					/>
				))}
			</CommandMenu.Group>
		</>
	);
}

/**
 * The folder a new session starts in now: the command's session's (a new session beside it), else the new-session
 * screen's choice while it shows; none elsewhere (the most recent folder is then the first).
 */
function useCurrentFolder(): NewSessionLocation | undefined {
	const { session } = useCommandSession();
	const { location } = useNewSessionState();
	const shows = useRoute().newSession === true;
	return useMemo(
		() => (session ? { env: session.env ?? null, cwd: session.cwd } : shows ? location : undefined),
		[session, shows, location],
	);
}

/** `folders` with `current` first: moved to the top, or added there when no session works in it yet. */
function withCurrent(folders: readonly Folder[], current: NewSessionLocation | undefined): readonly Folder[] {
	if (current === undefined) return folders;
	const known = folders.find((folder) => sameFolder(folder, current));
	const top: Folder = known ?? {
		key: folderKey(current.env, current.cwd),
		target: { kind: "folder", ...current },
		active: 0,
	};
	return [top, ...folders.filter((folder) => folder !== known)];
}

const sameFolder = (folder: Folder, location: NewSessionLocation): boolean =>
	folder.target.env === location.env && folder.target.cwd === location.cwd;

const locationOf = (folder: Folder): NewSessionLocation => ({ env: folder.target.env, cwd: folder.target.cwd });

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
					title={folderTitle(folder)}
					suffix={folderWhere(folder)}
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
