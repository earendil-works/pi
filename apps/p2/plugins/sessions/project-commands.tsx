// The projects' part of the command menu: on a session target Move to project…; on a project target (a sidebar project
// row: its ⋯, a long press, or hovered) Rename project…, Change default location…, Move project up and down, Archive
// project and Delete project…; on an archived project (the Archive's list) Restore project and Delete project…; and the
// new-session screen's project page, which sets the project a new session joins and starts it at the project's
// default place.
import { BACKGROUND_CONTEXT, type Ref, withHeld } from "@p2/app/v1";
import {
	ArchiveIcon,
	CloseIcon,
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	type CommandTarget,
	FolderIcon,
	FolderMoveIcon,
	getNavigation,
	NEW_SESSION,
	type NewSessionJoin,
	openLayer,
	PencilIcon,
	RestoreIcon,
	useCommandMenu,
	useCommandQuery,
	useCommandTarget,
	useComposerState,
	useHost,
	useNewSessionState,
} from "@p2/app/v1/web";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Projects } from "../projects/contract.ts";
import { NotArchived, useCommandSession } from "./command-session.tsx";
import { pageData, usePageData } from "./sidebar/page-data.ts";

type Host = ReturnType<typeof useHost>;

/** A live project as the command menu's target (its sidebar row). */
export const projectTarget = (name: string): CommandTarget => ({
	type: "project",
	id: name,
	kind: "Project",
	label: name,
});

/** An archived project as the command menu's target (its row in the Archive's list). */
export const archivedProjectTarget = (name: string): CommandTarget => ({
	type: "archived-project",
	id: name,
	kind: "Archived project",
	label: name,
});

/** The sheet layer of the directory picker that sets a project's default place. */
export const PROJECT_LOCATION = "project-location";

/** The project whose default place the `PROJECT_LOCATION` picker sets (a picker's steps keep only the folder). */
let locating: string | undefined;

/** The project the default-place picker is open for, if any. */
export const locatingProject = (): string | undefined => locating;

/** How a new session joins project `name` once it exists (the new-session screen, a project's "+"). */
export function projectJoin(host: Host, name: string): NewSessionJoin {
	return {
		label: name,
		run: (session) =>
			withHeld(host.hold(Projects, {}, BACKGROUND_CONTEXT), (live) =>
				live.assign({ session, project: name }, BACKGROUND_CONTEXT),
			),
	};
}

/** The commands, by id. */
export const PROJECT_COMMANDS: Readonly<Record<string, Command>> = {
	"projects.move-session": {
		title: "Move to project…",
		group: "Session",
		order: 10,
		icon: FolderMoveIcon,
		keywords: ["project", "group"],
		target: ["session"],
		owner: true,
		Shown: NotArchived,
		action: { kind: "page", page: "move-to-project" },
	},
	"projects.rename": {
		title: "Rename project…",
		group: "Project",
		order: 20,
		icon: PencilIcon,
		target: ["project"],
		owner: true,
		action: { kind: "page", page: "rename-project" },
	},
	"projects.locate": {
		title: "Change default location…",
		group: "Project",
		order: 20,
		icon: FolderIcon,
		keywords: ["folder", "machine", "directory"],
		target: ["project"],
		owner: true,
		action: { kind: "run", run: locate },
	},
	"projects.move-up": {
		title: "Move project up",
		group: "Project",
		order: 20,
		keywords: ["reorder"],
		target: ["project"],
		owner: true,
		Shown: ({ children }) => (moveOf(usePageData()?.context.projects, useCommandTarget(), -1) ? children : null),
		action: { kind: "run", run: (ctx) => moveProject(ctx, -1) },
	},
	"projects.move-down": {
		title: "Move project down",
		group: "Project",
		order: 20,
		keywords: ["reorder"],
		target: ["project"],
		owner: true,
		Shown: ({ children }) => (moveOf(usePageData()?.context.projects, useCommandTarget(), 1) ? children : null),
		action: { kind: "run", run: (ctx) => moveProject(ctx, 1) },
	},
	"projects.archive": {
		title: "Archive project",
		group: "Project",
		order: 20,
		icon: ArchiveIcon,
		keywords: ["hide"],
		target: ["project"],
		owner: true,
		action: { kind: "run", run: archive },
	},
	"projects.restore": {
		title: "Restore project",
		group: "Project",
		order: 20,
		icon: RestoreIcon,
		keywords: ["unarchive"],
		target: ["archived-project"],
		owner: true,
		action: {
			kind: "run",
			run: (ctx) => withProjects(ctx, (live, name) => live.restore({ name }, BACKGROUND_CONTEXT)),
		},
	},
	"projects.delete": {
		title: "Delete project…",
		group: "Project",
		order: 20,
		icon: CloseIcon,
		keywords: ["remove"],
		target: ["project", "archived-project"],
		owner: true,
		action: { kind: "page", page: "delete-project" },
	},
};

/** The pages, by name. */
export const PROJECT_PAGES: Readonly<Record<string, CommandPage>> = {
	"move-to-project": { label: "Move to project", placeholder: "Search projects…", Body: MoveToProjectPage },
	"rename-project": { label: "Rename", placeholder: "New name…", empty: "Type the new name", Body: RenameProjectPage },
	"delete-project": { label: "Delete", placeholder: "", Body: DeleteProjectPage },
	"new-session-project": { label: "Project", placeholder: "Search projects…", Body: NewSessionProjectPage },
};

/** Runs `action` with the owner's live `Projects` and the target project's name. */
async function withProjects(
	ctx: CommandContext,
	action: (live: Ref<typeof Projects>, name: string) => Promise<unknown>,
): Promise<void> {
	const name = ctx.target?.id;
	if (name === undefined) return;
	await withHeld(ctx.host.hold(Projects, {}, BACKGROUND_CONTEXT), (live) => action(live, name));
}

/** Archives the target project with its sessions; an open session of it gives way to the new-session screen first. */
function archive(ctx: CommandContext): Promise<void> {
	return withProjects(ctx, (live, name) => {
		const open = ctx.route.session;
		if (open !== undefined && pageData()?.context.memberships[open] === name)
			void getNavigation().replace(NEW_SESSION);
		return live.archive({ name }, BACKGROUND_CONTEXT);
	});
}

/** Opens the directory picker at the target project's default place; its choice becomes the new default. */
function locate(ctx: CommandContext): void {
	const name = ctx.target?.id;
	const project = pageData()?.context.projects.find((each) => each.name === name);
	if (!project) return;
	locating = project.name;
	const place = project.places[0];
	openLayer(directoryPickerLayer(place?.env ?? null, place?.path ?? "~", PROJECT_LOCATION));
}

/** Where the target project goes when moved up (-1) or down (1): before that project, null for the end. */
function moveOf(
	projects: readonly { name: string }[] | undefined,
	target: CommandTarget | undefined,
	by: -1 | 1,
): { name: string; before: string | null } | undefined {
	const at = projects?.findIndex((project) => project.name === target?.id) ?? -1;
	if (!projects || at === -1 || at + by < 0 || at + by >= projects.length) return undefined;
	return { name: projects[at]!.name, before: by < 0 ? projects[at - 1]!.name : (projects[at + 2]?.name ?? null) };
}

function moveProject(ctx: CommandContext, by: -1 | 1): void {
	const data = pageData();
	const move = moveOf(data?.context.projects, ctx.target, by);
	if (move) data?.onMoveProject?.(move.name, move.before);
}

/** "No project", then the live projects, the command's session's checked; picking one moves the session there. */
function MoveToProjectPage() {
	const { close } = useCommandMenu();
	const { id } = useCommandSession();
	const data = usePageData();
	if (!data || id === undefined) return null;
	const current = data.context.memberships[id];
	return (
		<ProjectRows
			current={data.context.projects.some((project) => project.name === current) ? current : undefined}
			onPick={async (name) => {
				await close();
				pageData()?.onAssign?.(id, name);
			}}
		/>
	);
}

/** The new-session screen's project: picking one joins it and starts at its default place; "No project" joins none. */
function NewSessionProjectPage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { join, setJoin, setLocation } = useNewSessionState();
	const projects = usePageData()?.context.projects ?? [];
	return (
		<ProjectRows
			current={join?.label}
			onPick={async (name) => {
				await close();
				const project = projects.find((each) => each.name === name);
				setJoin(project ? projectJoin(host, project.name) : undefined);
				const place = project?.places[0];
				if (place) setLocation({ env: place.env, cwd: place.path });
			}}
		/>
	);
}

/** The rows of a project choice: "No project", then the live projects in the owner's order, `current` checked. */
function ProjectRows({ current, onPick }: { current: string | undefined; onPick: (name: string | null) => void }) {
	const projects = usePageData()?.context.projects ?? [];
	const query = useCommandQuery().trim().toLowerCase();
	const matches = projects.filter((project) => project.name.toLowerCase().includes(query));
	const place = (project: (typeof projects)[number]) => {
		const first = project.places[0];
		return first ? (first.env ? `${first.env}:${first.path}` : first.path) : "";
	};
	return (
		<CommandMenu.Group heading="Projects">
			{(query === "" || "no project".includes(query)) && (
				<CommandMenu.Row title="No project" checked={current === undefined} onSelect={() => onPick(null)} />
			)}
			{matches.map((project) => (
				<CommandMenu.Row
					key={project.name}
					title={project.name}
					icon={FolderIcon}
					suffix={place(project)}
					checked={project.name === current}
					onSelect={() => onPick(project.name)}
				/>
			))}
		</CommandMenu.Group>
	);
}

/** The target project's new name is the page's query; its one row renames it. */
function RenameProjectPage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const name = useCommandTarget()?.id;
	const to = useCommandQuery().trim();
	if (name === undefined || to === "" || to === name) return null;
	return (
		<CommandMenu.Group heading="Project">
			<CommandMenu.Row
				title={`Rename to “${to}”`}
				icon={PencilIcon}
				onSelect={async () => {
					await close();
					await withHeld(host.hold(Projects, {}, BACKGROUND_CONTEXT), (live) =>
						live.rename({ name, to }, BACKGROUND_CONTEXT),
					).catch(fail);
				}}
			/>
		</CommandMenu.Group>
	);
}

/** Confirms deleting the target project: its sessions stay, in no project. */
function DeleteProjectPage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const name = useCommandTarget()?.id;
	const memberships = usePageData()?.context.memberships ?? {};
	if (name === undefined) return null;
	const count = Object.values(memberships).filter((project) => project === name).length;
	return (
		<CommandMenu.Group heading="Project">
			<CommandMenu.Row
				title={`Delete “${name}”`}
				icon={CloseIcon}
				suffix={
					count === 0 ? "No sessions" : `${count} ${count === 1 ? "session moves" : "sessions move"} to No project`
				}
				onSelect={async () => {
					await close();
					await withHeld(host.hold(Projects, {}, BACKGROUND_CONTEXT), (live) =>
						live.remove({ name }, BACKGROUND_CONTEXT),
					).catch(fail);
				}}
			/>
		</CommandMenu.Group>
	);
}
