// `OneThing`: a kind's seeded thing (`serveThing`'s `one`), for server code of any plugin: its id, the plugin's one
// thing of the kind in Pi, made by the store's `ensure` once the kind and its hooks are registered (the store seeds it
// at its start too, so it exists whether or not anyone asks).

import { type FacetHost, type P3Principal, until } from "@earendil-works/p3/v1";
import { OneThing, ThingHooks, ThingsStore } from "./contract.server.ts";
import { ThingKinds } from "./kind.ts";

/** Serves `OneThing` on `host`: the seeded thing of a kind, once its kind and hooks are registered. */
export function serveOne(host: FacetHost<P3Principal>): void {
	host.serve(OneThing, ({ kind }, self) => {
		const kinds = self.registry(ThingKinds);
		const hooks = self.registry(ThingHooks);
		const store = self.get(ThingsStore, {});
		return {
			thing: self.follow<string>(async (_observer, ctx) => {
				// A kind's plugin may load after this object starts: it waits (loading) until the kind asks for one.
				await until(kinds, (table) => table.has(kind), ctx);
				const entry = (await until(hooks, (table) => table.get(kind)?.value.one !== undefined, ctx)).get(kind)!;
				const [pi] = (await store.workspaces.children.page({ parent: "" }, 1, ctx)).items;
				const args = { kind, name: entry.value.one!.name, workspace: pi!.workspace, plugin: entry.plugin };
				// The id never changes while the thing lives: nothing to follow after it.
				return { value: await store.ensure(args, ctx), detach: () => {} };
			}),
		};
	});
}
