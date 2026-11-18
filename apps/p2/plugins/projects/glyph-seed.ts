// Which project glyph a place shows (the chat's top bar; the glyphs plugin draws it): its project's (place.ts), else
// its own path's. Browser-safe; in the projects plugin because it reads projects alone, so other plugins' web facets
// import it with nothing else.
import type { Project } from "./contract.ts";
import { projectAt } from "./place.ts";

/** A project's glyph seed: its first place's path (its name without places). */
export const projectSeed = (project: Project): string => project.places[0]?.path ?? project.name;

/** The glyph seed of the place `env`/`cwd`: its project's (`projectAt`) `projectSeed`, else the place's own path. */
export function placeSeed(projects: readonly Project[], env: string | null, cwd: string, member?: string): string {
	const project = projectAt(projects, env, cwd, member);
	return project ? projectSeed(project) : cwd;
}
