// The plain workspace kind (`things.workspace`, decision 13): Pi, a project, Family. It holds things, people and other
// workspaces; its ticks are the workspace ticks (`WORKSPACE_TICKS`) and the Make ticks; it has no members of its own,
// so it serves no object of its own: what pages and agents hold of a workspace is `Workspace` (`workspace-object.ts`).
// The things plugin registers it like any kind (data in `ThingKinds`), made by people (an agent makes sessions and
// content, never workspaces).

import { contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { defineWorkspace, ThingKinds } from "./kind.ts";

/** The things plugin's package name: the source of what it writes itself (Pi, a leaf's agent put in). */
export const THINGS_PLUGIN = "@earendil-works/p3-things";

/** The plain workspace kind: no members, no ticks of its own; made by people. */
export const WorkspaceKind = defineWorkspace("things.workspace", {
	version: 1,
	leaf: false,
	makers: "people",
	ticks: {},
});

/** Registers the plain workspace kind on `host` (its data in `ThingKinds`). */
export function serveWorkspaceKind(host: FacetHost<P3Principal>): void {
	contribute(host, `${WorkspaceKind.name}.kind`, (self) => self.contribute(ThingKinds, WorkspaceKind.info));
}
