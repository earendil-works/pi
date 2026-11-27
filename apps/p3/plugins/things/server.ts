// The things plugin on the server: the store with its access index (`store.ts`), `Gives` (what every thing's
// admission derives from), `OneThing` (a kind's seeded thing), `ThingKindsView` (every kind's data for workers and
// pages), `Group` (a group's members and its own tick's calls), and the registries kinds and admissions meet in:
// `ThingKinds` (each kind's data), `ThingHooks` (each kind's hooks), `AccessHandles` (the store's index, R5); `MyAnswer`,
// a caller's answer for admissions off the server.

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { serveGives } from "./admission.ts";
import { serveMyAnswer } from "./answer.ts";
import { AccessHandles, OwnerSeeds, ThingHooks } from "./contract.server.ts";
import { serveGroup } from "./group.ts";
import { kindView, ThingKinds, ThingKindsView } from "./kind.ts";
import { serveLists } from "./lists.ts";
import { serveOne } from "./one.ts";
import { serveOwnerBridge } from "./owner-bridge.ts";
import { serveStore } from "./store.ts";
import { serveWorkspace } from "./workspace-object.ts";
import { serveWorkspaceKind, THINGS_PLUGIN } from "./workspaces.ts";

export default defineFacet((host) => {
	host.serve(ThingKinds, {
		compose: (table, { report }) => keyedEntries(table, (info) => ({ [info.name]: info }), report),
	});
	host.serve(ThingHooks, {
		compose: (table, { report }) => keyedEntries(table, (hook) => ({ [hook.kind]: hook }), report),
	});
	// Only the things plugin's own store contributes the index admissions read; any other contribution is ignored.
	// The people plugin's owner, until push B (ERNDL-1144) removes the people plugin.
	host.serve(OwnerSeeds, {
		compose: (table) => table.find(({ plugin }) => plugin === "@earendil-works/p3-people")?.value ?? null,
	});
	host.serve(AccessHandles, { compose: (table) => table.find(({ plugin }) => plugin === THINGS_PLUGIN)?.value });
	// Every kind's data for workers and pages, following the registry.
	host.serve(ThingKindsView, (_params, _principal, self) => ({
		kinds: self.derive([self.registry(ThingKinds)], ([table]) =>
			Object.fromEntries([...table].map(([name, { value, plugin }]) => [name, kindView(value, plugin)])),
		),
	}));
	serveStore(host);
	serveGives(host);
	serveMyAnswer(host);
	serveOne(host);
	serveWorkspaceKind(host);
	serveWorkspace(host);
	serveLists(host);
	serveGroup(host);
	serveOwnerBridge(host);
});
