// Serves `projects.json` and the sessions' projects to the owner: one object for the server (`ProjectService`: the
// file's observer and the persisted memberships), `Projects` per owner with this device's label, the server's hostname,
// and a copy of a session (`/clone`, `/fork`) joining its source's project.
import { hostname } from "node:os";
import { obj, str } from "@earendil-works/pi-schema";
import {
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	record,
} from "@p2/app/v1";
import { Server } from "@p2/app/v1/server";
import { SessionCopied } from "../sessions/contract.ts";
import { ProjectService, Projects } from "./contract.ts";
import { ProjectStore } from "./store.ts";

/**
 * The sessions' projects by session ID, in the server's store (`<data>/server/store.sqlite`), not the session catalog:
 * without this plugin the catalog stays as it is. Entries of archived sessions stay (a restore finds its project).
 */
const Memberships = defineState("p2.project-sessions", {
	schema: obj({ sessions: record(str()) }),
	version: 1,
	initial: () => ({ sessions: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

export default defineFacet((host) => {
	host.serve(ProjectService, (_params, self) => {
		const server = self.get(Server, {});
		const memberships = self.state(Memberships);
		const store = self.open(
			async () => {
				const opened = new ProjectStore(server.info.value.dataDir);
				await opened.observer.start();
				return opened;
			},
			(opened) => opened.observer.close(),
		);
		const snapshot = followNative(
			self,
			(changed) => store.value.subscribe(changed),
			() => store.value.snapshot,
		);
		return {
			projects: deriveTyped(self, [snapshot], ([value]) => value.projects),
			failure: self.derive([snapshot], ([value]) => value.error),
			sessions: self.derive([memberships], ([value]) => value.sessions),
			assign: async ({ session, project }, ctx) => {
				if (!store.value.snapshot.projects.some((each) => each.name === project))
					throw new Error(`No project "${project}" in projects.json`);
				await memberships.change((draft) => {
					draft.sessions[session] = project;
				}, ctx);
				return null;
			},
			copy: async ({ source, copy }, ctx) => {
				const project = memberships.value.sessions[source];
				if (project !== undefined)
					await memberships.change((draft) => {
						draft.sessions[copy] = project;
					}, ctx);
				return null;
			},
		};
	});

	host.serve(Projects, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("projects are owner-only");
		const service = self.get(ProjectService, {});
		const label = hostname();
		return {
			variant: "owner",
			members: {
				projects: service.projects,
				failure: service.failure,
				// A constant: a derive of no sources.
				local: self.derive([], () => label),
				sessions: service.sessions,
				assign: (args, ctx) => service.assign(args, ctx),
			},
		};
	});

	// A copy keeps its source's project; the copy goes on if that cannot be recorded.
	contribute(host, "p2.projects-copied", (self) => {
		const service = self.get(ProjectService, {});
		self.contribute(SessionCopied, {
			projects: (source, copy, ctx) =>
				service
					.copy({ source, copy }, ctx)
					.then(() => {})
					.catch((error: unknown) => console.error(`p2 projects: session ${copy} kept no project:`, error)),
		});
	});
});
