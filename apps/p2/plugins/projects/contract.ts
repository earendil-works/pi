// Projects: one codebase's places on several machines (`projects.json`), which sessions belong to which project, and
// the helpers that find a project's place on a machine and a directory's subpath below a place. Browser-safe: the
// sessions TUI uses them.
import { arr, nul, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { LOCAL, local, method, record, remote, serverHost } from "@p2/app/v1";

/** Where a project lives on one machine: `env` null is this device; `path` may start with `~` (that machine's home). */
export const ProjectPlaceSchema = obj({ env: union([str(), nul()]), path: str() });
export type ProjectPlace = Static<typeof ProjectPlaceSchema>;

/** A project: its name and its places, most preferred first, at most one per environment. */
export const ProjectSchema = obj({ name: str(), places: arr(ProjectPlaceSchema) });
export type Project = Static<typeof ProjectSchema>;

/** Session `session` belongs to project `project` from now on. */
const Assign = obj({ session: str({ maxLength: 64 }), project: str({ maxLength: 64 }) });

/**
 * `projects.json` as last read validly (in the file's order), why the last read failed, and the sessions' projects by
 * session ID (server, host-internal; persisted in the server's store, never in the session catalog). A session belongs
 * to a project only when it was started from the project's row (`assign`) or copied from such a session (`copy`, the
 * sessions plugin's `SessionCopied`); nothing clears it, so a name may outlive its project in projects.json.
 */
export const ProjectService = local("p2.project-service", {
	version: 1,
	params: {},
	members: {
		projects: arr(ProjectSchema),
		failure: union([str(), nul()]),
		sessions: record(str()),
		/** Refused for a project projects.json does not name. */
		assign: method(Assign),
		/** `copy` belongs to `source`'s project, if it has one. */
		copy: method(obj({ source: str(), copy: str() })),
	},
});

/**
 * The owner's projects, the last read's failure, this device's name in place labels (the server's hostname) and the
 * sessions' projects by session ID; `assign` is the TUI's project rows starting a session.
 */
export const Projects = remote("p2.projects", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				projects: arr(ProjectSchema),
				failure: union([str(), nul()]),
				local: str(),
				sessions: record(str()),
			},
			methods: { assign: method(Assign) },
		},
	},
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
