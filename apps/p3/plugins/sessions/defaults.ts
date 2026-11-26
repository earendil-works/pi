// The session defaults kind on the server (`SessionDefaultsKind`, 09): its settings (model, shared or private, the view
// a new session opens with) in a table of its own, set by Configure, seeded once in Pi; and `nearestDefaults`, what a
// new session made somewhere starts with: the nearest defaults thing available there (one read of `Gives`, as the
// server: switches applied, whoever makes the session), else the plugin's own.

import {
	type Ctx,
	callerKey,
	defineTable,
	eq,
	type FacetHost,
	json,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	str,
} from "@earendil-works/p3/v1";
import { Gives } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { SessionDefaults } from "./contract.ts";
import { SessionDefaultsKind } from "./kind.ts";

/** Serves the session defaults kind on `host`: its settings' store and the kind. */
export function serveDefaultsKind(host: FacetHost<P3Principal>): void {
	serveSettings(host);
	serveThing(host, SessionDefaultsKind, {
		implement: ({ thing }, _admitted, self) => {
			const set = self.liveQuery(self.get(DefaultsSettings, {}).settings.of, { thing }, { first: 1 });
			return { defaults: self.derive([set], ([{ rows }]) => rows[0]?.defaults ?? DEFAULTS) };
		},
		configure: async (thing, settings, ctx) => {
			// `Workspace.configure` checked the value against the `defaults` member's schema.
			if (settings.defaults === undefined) return;
			const defaults = settings.defaults as SessionDefaults;
			await (await ctx.get(DefaultsSettings, {})).set({ thing, defaults }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(DefaultsSettings, {})).remove({ thing }, ctx);
		},
		one: { name: "Session defaults" },
	});
}

/** What a session starts with where no defaults thing is available, and a defaults thing nobody configured yet. */
export const DEFAULTS: SessionDefaults = { model: null, shared: true, opensWith: null };

/**
 * What a session made in `workspace` starts with: the settings of the defaults thing available there (the index
 * answers only the nearest of a `stacking: "nearest"` kind, decision 75; of two linked together the first by id), read
 * while that thing is still the one, else `DEFAULTS`. Asked as the server: what is available, not what the maker sees.
 */
export async function nearestDefaults(workspace: string, ctx: Ctx<P3Principal>): Promise<SessionDefaults> {
	const gives = await ctx.get(Gives, { workspace, caller: callerKey({ kind: "server" }) });
	const settings = await ctx.get(DefaultsSettings, {});
	const chosen = (): string | undefined => {
		const given = gives.answers.value;
		return Object.keys(given)
			.filter((id) => given[id]?.kind === SessionDefaultsKind.name)
			.sort()[0];
	};
	for (;;) {
		const thing = chosen();
		if (thing === undefined) return DEFAULTS;
		const set = (await settings.settings.of.page({ thing }, 1, ctx)).items[0];
		// A defaults thing replaced or taken away while its settings were read (Astra, round 1): read the one that is.
		if (chosen() === thing) return set?.defaults ?? DEFAULTS;
	}
}

/** The defaults things' settings, once per server: one row per thing whose settings were set (its own facets', and the plan test's). */
export const DefaultsSettings = local("sessions.defaults-settings", {
	version: 1,
	params: {},
	members: {
		settings: queries(obj({ thing: str(), defaults: SessionDefaults }), {
			/** Thing `thing`'s settings, if they were set. */
			of: obj({ thing: str() }),
		}),
		set: method(obj({ thing: str(), defaults: SessionDefaults })),
		remove: method(obj({ thing: str() })),
	},
});

/** Each defaults thing's settings, by thing (none set: `DEFAULTS`). */
const Settings = defineTable("sessions.settings", {
	version: 1,
	columns: { thing: str(), defaults: json(SessionDefaults, { version: 1 }) },
	key: ["thing"],
});

/** Serves `DefaultsSettings` on `host`. */
function serveSettings(host: FacetHost<P3Principal>): void {
	host.serve(DefaultsSettings, (_params, self) => {
		const settings = self.table(Settings);
		return {
			settings: self.queries(
				settings,
				// `defaults` holds only what `set` wrote, checked against `SessionDefaults` by `Workspace.configure`.
				{ map: ({ thing, defaults }) => ({ thing, defaults: defaults as SessionDefaults }) },
				{
					// The key.
					of: ({ thing }: { thing: string }) => query(Settings).where((row) => eq(row.thing, thing)),
				},
			),
			set: ({ thing, defaults }, ctx) =>
				self.tx(async (tx) => {
					tx.put(settings, { thing, defaults });
					return null;
				}, ctx),
			remove: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(settings, { thing });
					return null;
				}, ctx),
		};
	});
}
