// Projects: the owner's groupings of sessions, each with its places (where its sessions start, the first one by default;
// `/move` goes to another machine's), in the owner's order; which project each session belongs to; each project's
// coordinator session; and the helpers that find a project's place on a machine and a directory's subpath below a place.
// Browser-safe: the sessions TUI uses them.
import { arr, nul, num, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { LOCAL, local, method, record, remote, serverHost } from "@p2/app/v1";

/** Where a project lives on one machine: `env` null is this device; `path` may start with `~` (that machine's home). */
export const ProjectPlaceSchema = obj({ env: union([str(), nul()]), path: str() });
export type ProjectPlace = Static<typeof ProjectPlaceSchema>;

/**
 * A project: its name (unique, how sessions name it) and its places, the default one first, at most one per
 * environment.
 */
export const ProjectSchema = obj({ name: str(), places: arr(ProjectPlaceSchema) });
export type Project = Static<typeof ProjectSchema>;

/** An archived project: it and the sessions it had then are in the Archive until it is restored. */
export const ArchivedProjectSchema = obj({ name: str(), places: arr(ProjectPlaceSchema), archivedAt: num() });
export type ArchivedProject = Static<typeof ArchivedProjectSchema>;

const Name = str({ minLength: 1, maxLength: 64 });
const NameOnly = obj({ name: Name });
const Place = obj({ env: union([str({ maxLength: 32 }), nul()]), path: str({ minLength: 1, maxLength: 4096 }) });

/** Session `session` belongs to project `project` from now on, or (null) to none. */
const Assign = obj({ session: str({ maxLength: 64 }), project: union([str({ maxLength: 64 }), nul()]) });

/** A new project at one place, after the others. */
const Create = obj({ name: Name, place: Place });

/** A project's coordinator session, as `open` answers. */
const Opened = obj({ id: str() });

/** `WorkerInitValues` key: whether the starting worker's session is a project's coordinator (a boolean). */
export const COORDINATOR_INIT = "projectCoordinator";

/**
 * The owner's projects and the sessions' projects (server, host-internal; persisted in the server's store, never in
 * the session catalog). A session belongs to a project only when the owner put it there (`assign`: the new-session
 * screen, the sidebar's Move to and drag and drop) or it was copied from a session that did (`copy`, the sessions
 * plugin's `SessionCopied`). Names are unique; a rename moves the project's sessions with it. Each project may have a
 * coordinator: a session of it, made by the first `open`, that starts and steers the project's other sessions. 3:
 * `coordinators` and `open`.
 */
export const ProjectService = local("p2.project-service", {
	version: 3,
	params: {},
	members: {
		/** The live projects, in the owner's order. */
		projects: arr(ProjectSchema),
		/** The archived projects, the most recently archived first. */
		archived: arr(ArchivedProjectSchema),
		/** Session ID to project name, archived projects' sessions included. */
		sessions: record(str()),
		/** Project name to its coordinator's session ID, once the first `open` chose it. */
		coordinators: record(str()),
		/**
		 * Refused for a project that is not live, and for a coordinator leaving its project; `project` null: the session
		 * belongs to none.
		 */
		assign: method(Assign),
		/** `copy` belongs to `source`'s project, if it has one. */
		copy: method(obj({ source: str(), copy: str() })),
		create: method(Create),
		/** Renames a project; its sessions follow. */
		rename: method(obj({ name: Name, to: Name })),
		/** `place` becomes the project's default place (first), replacing its place on that machine. */
		locate: method(obj({ name: Name, place: Place })),
		/** Moves a live project before `before` (null: to the end). */
		move: method(obj({ name: Name, before: union([Name, nul()]) })),
		/** Archives a live project and every live session of it. */
		archive: method(NameOnly),
		/** Restores an archived project and the sessions archived with it, after the live projects. */
		restore: method(NameOnly),
		/**
		 * Deletes a project (live or archived): its sessions belong to none; no session is deleted, its coordinator is
		 * archived.
		 */
		remove: method(NameOnly),
		/**
		 * A live project's coordinator: made on the first call (at the project's default place, with the default model) or
		 * restored when archived. One call at a time: two pages opening it at once make one session.
		 */
		open: method(NameOnly, Opened),
	},
});

/**
 * The owner's projects, archived ones, this device's name in place labels (the server's hostname) and the sessions'
 * projects by session ID (`ProjectService`). 2: `create`. 3: projects live in the server's store, managed from the
 * web (rename, default place, order, archive, restore, delete; `assign` with null leaves a project); no projects.json,
 * so no `failure`. 4: a new base (grantable members replaced variants; older versions are refused, their pages
 * reload).
 */
export const Projects = remote("p2.projects", {
	version: 4,
	params: {},
	hostAddress: serverHost,
	state: {
		projects: arr(ProjectSchema),
		archived: arr(ArchivedProjectSchema),
		local: str(),
		sessions: record(str()),
	},
	methods: {
		assign: method(Assign),
		create: method(Create, nul()),
		rename: method(obj({ name: Name, to: Name }), nul()),
		locate: method(obj({ name: Name, place: Place }), nul()),
		move: method(obj({ name: Name, before: union([Name, nul()]) }), nul()),
		archive: method(NameOnly, nul()),
		restore: method(NameOnly, nul()),
		remove: method(NameOnly, nul()),
	},
});

/** The projects' coordinators for the owner: project name to session ID, and `open`, which makes one on first use. */
export const ProjectCoordinators = remote("p2.project-coordinators", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	state: { sessions: record(str()) },
	methods: { open: method(NameOnly, Opened) },
});

/** For a session's current worker: the name of the project its session coordinates, or null for none. */
export const CoordinatedProject = remote("p2.coordinated-project", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	methods: { project: method(undefined, union([str(), nul()])) },
});

/** How a place's machine reads: its environment's name, or this device's label. */
export const placeLabel = (place: ProjectPlace, localLabel: string): string => place.env ?? localLabel;

/**
 * Where the absolute `path` sits below the place path `root`, from the text alone: the rest below it ("" at the root;
 * either separator), or undefined outside it. An absolute root contains what `isWithin` says. `~/rel` contains `path`
 * when `path` has `/rel` at segment boundaries after a non-empty prefix (that machine's home, unknown here). `~`
 * contains every path, its rest unknown without the home: "".
 */
export function below(path: string, root: string): string | undefined {
	const rest = (from: number) => path.slice(from).replace(/^[\\/]+/, "");
	if (root.startsWith("~")) {
		const relative = root
			.slice(1)
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		if (!relative) return "";
		// Separators made alike without changing lengths, so an index in `text` is one in `path`.
		const text = path.replace(/\\/g, "/");
		for (let index = text.indexOf(`/${relative}`, 1); index > 0; index = text.indexOf(`/${relative}`, index + 1)) {
			const end = index + 1 + relative.length;
			if (end === text.length || text[end] === "/") return rest(end);
		}
		return undefined;
	}
	return isWithin(path, root) ? rest(root.replace(/[\\/]+$/, "").length) : undefined;
}

/** Whether `path` is `root` or below it (either separator, so Windows machines match too). */
function isWithin(path: string, root: string): boolean {
	const base = root.replace(/[\\/]+$/, "");
	return path === root || path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/**
 * The place of `project` on the machine `name` names: an environment's name, or this device as `local` or its label
 * (case-insensitive, as host names are). An environment of that name wins over this device.
 */
export function placeOn(project: Project, name: string, localLabel: string): ProjectPlace | undefined {
	const remote = project.places.find((place) => place.env === name);
	if (remote) return remote;
	const here = name === LOCAL || name.toLowerCase() === localLabel.toLowerCase();
	return here ? project.places.find((place) => place.env === null) : undefined;
}
