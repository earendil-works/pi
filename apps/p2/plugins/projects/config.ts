// `projects.json` in the data directory: `{ "<name>": [{ "env"?: "<environment>", "path": "<directory>" }, ...] }`.
// Object order is display order, array order is preference; a place without `env` is this device.
import { join } from "node:path";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import { isRooted } from "@p2/app/v1";
import { optionalText, stripBom, stripJsonComments } from "@p2/app/v1/node";
import type { Project } from "./contract.ts";

/** envs' `ENV_NAME`: the names an environment may have (copied: plugins share only contracts). */
const ENV_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const isPlace = compile(
	obj({ env: opt(str({ minLength: 1, maxLength: 32 })), path: str({ minLength: 1, maxLength: 4096 }) }),
).check;

/** Whether `value` has a control character (C0 or DEL), as envs' configuration checks. */
const hasControl = (value: string): boolean =>
	[...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);

/** Reads `projects.json`'s text; throws with the first problem, naming the project. */
export function parseProjects(content: string): Project[] {
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		throw new Error("Invalid projects.json syntax");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("projects.json must be an object of projects");
	return Object.entries(value).map(([name, places]) => ({ name, places: parsePlaces(name, places) }));
}

/** One project's places: absolute or `~` paths, at most one per environment. */
function parsePlaces(name: string, places: unknown): Project["places"] {
	if (!name.trim() || name.length > 64 || hasControl(name)) throw new Error(`Invalid project name: ${name}`);
	if (!Array.isArray(places) || places.length === 0)
		throw new Error(`Project ${name}: a list of places ({ "env"?, "path" }) is required`);
	const seen = new Set<string | null>();
	return places.map((place: unknown) => {
		if (!isPlace(place)) throw new Error(`Project ${name}: a place is { "env"?: string, "path": string }`);
		const env = place.env ?? null;
		if (env !== null && !ENV_NAME.test(env)) throw new Error(`Project ${name}: invalid environment name ${env}`);
		if (!isRooted(place.path) || hasControl(place.path))
			throw new Error(`Project ${name}: the path must be absolute or start with ~ (${place.path})`);
		if (seen.has(env)) throw new Error(`Project ${name}: two places on ${env ?? "this device"}`);
		seen.add(env);
		return { env, path: place.path };
	});
}

export function projectsPath(directory: string): string {
	return join(directory, "projects.json");
}

/** The projects of `directory`'s `projects.json` (none without one). */
export async function loadProjects(directory: string): Promise<Project[]> {
	return parseProjects((await optionalText(projectsPath(directory))) ?? "{}");
}
