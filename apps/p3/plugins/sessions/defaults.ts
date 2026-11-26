// The session defaults kind on the server (`SessionDefaultsKind`, 09): its settings (model, shared or private, the view
// a new session opens with) stored by thing, set by Configure, seeded once in Pi; and `nearestDefaults`, what a new
// session made somewhere starts with: the nearest defaults thing its maker is given there (one read of `Gives`), else
// the plugin's own.

import type { Ctx, FacetHost, P3Principal } from "@earendil-works/p3/v1";
import { Gives } from "../things/contract.server.ts";
import type { Source } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { SessionsStore } from "./contract.server.ts";
import { type SessionDefaults, SessionDefaultsKind } from "./contract.ts";

/** Serves the session defaults kind on `host`. */
export function serveDefaultsKind(host: FacetHost<P3Principal>): void {
	serveThing(host, SessionDefaultsKind, {
		implement: ({ thing }, _admitted, self) => {
			const set = self.liveQuery(self.get(SessionsStore, {}).defaults.one, { thing }, { first: 1 });
			return { defaults: self.derive([set], ([{ rows }]) => rows[0]?.defaults ?? DEFAULTS) };
		},
		configure: async (thing, settings, ctx) => {
			// `Workspace.configure` checked the value against the `defaults` member's schema.
			if (settings.defaults === undefined) return;
			const defaults = settings.defaults as SessionDefaults;
			await (await ctx.get(SessionsStore, {})).setDefaults({ thing, defaults }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(SessionsStore, {})).removeDefaults({ thing }, ctx);
		},
		one: { name: "Session defaults" },
	});
}

/** What a session starts with where no defaults thing applies, and a defaults thing nobody configured yet. */
export const DEFAULTS: SessionDefaults = { model: null, shared: true, opensWith: null };

/**
 * What a session made in `workspace` by `by` starts with: the settings of the defaults thing `by` is given there (the
 * index answers only the nearest of a `stacking: "nearest"` kind, decision 75; of two linked together the first by id),
 * else `DEFAULTS`.
 */
export async function nearestDefaults(workspace: string, by: Source, ctx: Ctx<P3Principal>): Promise<SessionDefaults> {
	const given = (await ctx.get(Gives, { workspace, caller: callerOf(by) })).answers.value;
	const [thing] = Object.keys(given)
		.filter((id) => given[id]?.kind === SessionDefaultsKind.name)
		.sort();
	if (thing === undefined) return DEFAULTS;
	const set = (await (await ctx.get(SessionsStore, {})).defaults.one.page({ thing }, 1, ctx)).items[0];
	return set?.defaults ?? DEFAULTS;
}

/** The caller key of `by` (`callerKey`'s texts): a person, a session's agent, else the server (plugins' code). */
function callerOf(by: Source): string {
	switch (by.kind) {
		case "person":
			return `person:${by.person}`;
		case "agent":
			return `worker:${by.session}`;
		default:
			return "server";
	}
}
