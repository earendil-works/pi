// The notes app's API, version 1, shared by every host kind (`@notes/app/v1`): what its plugins import from their
// host. The part of Chord the app supports, the kit's start-data objects and files, the app's own host kind (a
// project, one worker per project) and its registry of home-page sections. The API only declares the registry: its
// provider is the home plugin of the app's required root, not base code. Examples 53 to 55 run this app; a real app
// keeps it in `src/api/v1.ts`.

import { defineRegistry, hostKind, str } from "../../../../src/index.ts";

export {
	arr,
	constant,
	defineFacet,
	defineRegistry,
	defineState,
	defineTable,
	int,
	local,
	method,
	obj,
	remote,
	str,
} from "../../../../src/index.ts";
export { AppInfo, Files, WorkerInfo } from "../../../../src/node/app/index.ts";

/** A project of the app: its own worker process, store and files. */
export const Project = hostKind("project", { id: str() });

/** The home page's sections, one per contributing plugin (title and the path it links to). */
export const Sections = defineRegistry<{ readonly title: string; readonly path: string }, string[]>("notes.sections", {
	version: 1,
});
