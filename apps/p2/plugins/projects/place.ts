// Which project a place belongs to: the project a session joined, else the project whose place holds the folder most
// closely (the sidebar groups sessions by it; the chat's top bar shows its glyph). Browser-safe, as contract.ts.
import { below, type Project, type ProjectPlace } from "./contract.ts";

/**
 * The project of the place `env`/`cwd`: the project named `member` (a session's membership), else the project with a
 * place on that machine that contains it, the closest one when several do (a project at `/w/web` before one at `/w`;
 * a place at `~` last); else none.
 */
export function projectAt(
	projects: readonly Project[],
	env: string | null,
	cwd: string,
	member?: string,
): Project | undefined {
	const joined = projects.find((each) => each.name === member);
	if (joined) return joined;
	let closest: { project: Project; depth: number } | undefined;
	for (const project of projects)
		for (const place of project.places) {
			if (place.env !== env || below(cwd, place.path) === undefined) continue;
			const depth = depthOf(place);
			if (closest === undefined || depth > closest.depth) closest = { project, depth };
		}
	return closest?.project;
}

/** How deep a place's path reaches: its segments (`~` counts none, so any absolute place is closer). */
const depthOf = (place: ProjectPlace): number =>
	place.path.split(/[\\/]+/).filter((part) => part && part !== "~").length;
