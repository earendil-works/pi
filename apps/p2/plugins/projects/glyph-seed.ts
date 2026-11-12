// Which project glyph a place shows: the project's when the place belongs to one, so a project, its folders and its
// sessions look alike (the sidebar, the chat's top bar; the glyphs plugin draws them). Browser-safe; in the projects
// plugin because it reads projects alone, so other plugins' web facets import it with nothing else.
import { below, type Project } from "./contract.ts";

/** A project's glyph seed: its first place's path (its name without places). */
export const projectSeed = (project: Project): string => project.places[0]?.path ?? project.name;

/**
 * The glyph seed of the place `env`/`cwd`: the project named `member` (a session's membership), else a project with a
 * place containing it on that machine, by its `projectSeed`; else the place's own path.
 */
export function placeSeed(projects: readonly Project[], env: string | null, cwd: string, member?: string): string {
	const project =
		projects.find((each) => each.name === member) ??
		projects.find((each) => each.places.some((place) => place.env === env && below(cwd, place.path) !== undefined));
	return project ? projectSeed(project) : cwd;
}
