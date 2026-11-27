// The session defaults kind on the server (`SessionDefaultsKind`, 09): its settings (model, shared or private, the view
// a new session opens with, where it works) in a table of its own, set by Configure, seeded once in Pi; `nearestDefaults`,
// what a new session made somewhere starts with: the nearest defaults thing available there (one read of `Gives`, as
// the server: switches applied, whoever makes the session), else the plugin's own; and `SessionDefaultsHere`, the same,
// live, for the new-session step of a person present there.

import { isAbsolute } from "node:path";
import {
	allow,
	bool,
	type Ctx,
	callerKey,
	defineTable,
	deny,
	eq,
	evolveTable,
	type FacetHost,
	invalid,
	json,
	local,
	method,
	nul,
	obj,
	type P3Principal,
	queries,
	query,
	str,
	union,
} from "@earendil-works/p3/v1";
import { MACHINE_KIND } from "../environments/contract.ts";
import { Gives, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { ModelChoice, SessionDefaults, SessionDefaultsHere } from "./contract.ts";
import { SessionDefaultsKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { ModelChoiceV1 } from "./store.ts";

/** Serves the session defaults kind on `host`: its settings' store and the kind. */
export function serveDefaultsKind(host: FacetHost<P3Principal>): void {
	serveSettings(host);
	serveDefaultsHere(host);
	serveThing(host, SessionDefaultsKind, {
		implement: ({ thing }, _admitted, self) => {
			const set = self.liveQuery(self.get(DefaultsSettings, {}).settings.of, { thing }, { first: 1 });
			return { defaults: self.derive([set], ([{ rows }]) => rows[0]?.defaults ?? DEFAULTS) };
		},
		configure: async (thing, settings, ctx) => {
			// `Workspace.configure` checked the value against the `defaults` member's schema.
			if (settings.defaults === undefined) return;
			const defaults = settings.defaults as SessionDefaults;
			// What a make would refuse is refused here already (Astra, push 5): a folder that is no full path (`""` is the
			// own folder), a machine that is no machine thing.
			if (defaults.location !== null) {
				const { machine, folder } = defaults.location;
				if (folder !== "" && !isAbsolute(folder)) {
					throw invalid("args", `sessions: ${folder} is no full path`, {
						message: messages.message("notFullPath"),
					});
				}
				const found = (await (await ctx.get(ThingsStore, {})).things.one.page({ thing: machine }, 1, ctx)).items[0];
				if (found?.kind !== MACHINE_KIND) {
					throw invalid("args", `sessions: no machine ${machine}`, {
						message: messages.message("noMachine", machine),
					});
				}
			}
			await (await ctx.get(DefaultsSettings, {})).set({ thing, defaults }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(DefaultsSettings, {})).remove({ thing }, ctx);
		},
		one: { name: "Session defaults" },
	});
}

/** What a session starts with where no defaults thing is available, and a defaults thing nobody configured yet. */
export const DEFAULTS: SessionDefaults = { model: null, shared: true, opensWith: null, location: null };

/**
 * What a session made in `workspace` starts with: the settings of the defaults thing available there (the index
 * answers only the nearest of a `stacking: "nearest"` kind, decision 75; of two linked together the first by id), read
 * while that thing is still the one, else `DEFAULTS`. Asked as the server: what is available, not what the maker sees.
 */
export async function nearestDefaults(workspace: string, ctx: Ctx<P3Principal>): Promise<SessionDefaults> {
	const gives = await ctx.get(Gives, { workspace, caller: callerKey({ kind: "server" }) });
	const settings = await ctx.get(DefaultsSettings, {});
	const chosen = () => chosenDefaults(gives.answers.value);
	for (;;) {
		const thing = chosen();
		if (thing === undefined) return DEFAULTS;
		const set = (await settings.settings.of.page({ thing }, 1, ctx)).items[0];
		// A defaults thing replaced or taken away while its settings were read (Astra, round 1): read the one that is.
		if (chosen() === thing) return set?.defaults ?? DEFAULTS;
	}
}

/** The defaults thing that applies of what a workspace gives (`Gives`' answers): of two, the first by id. */
function chosenDefaults(given: Readonly<Record<string, { readonly kind: string }>>): string | undefined {
	return Object.keys(given)
		.filter((id) => given[id]?.kind === SessionDefaultsKind.name)
		.sort()[0];
}

const ALLOWED = allow({});
const NOT_PRESENT = deny("sessions: not present in that workspace");

/**
 * Serves `SessionDefaultsHere` on `host`: what `nearestDefaults` answers, live, for a caller present in the workspace
 * (their answer on it).
 */
function serveDefaultsHere(host: FacetHost<P3Principal>): void {
	host.serve(
		SessionDefaultsHere,
		({ workspace }, _principal, _admitted, self) => {
			const gives = self.get(Gives, { workspace, caller: callerKey({ kind: "server" }) });
			const chosen = self.derive([gives.answers], ([given]) => ({ thing: chosenDefaults(given) ?? "" }));
			const set = self.liveQuery(self.get(DefaultsSettings, {}).settings.of, chosen, { first: 1 });
			return {
				defaults: self.derive([chosen, set], ([{ thing }, { rows }]) =>
					thing === "" ? DEFAULTS : (rows[0]?.defaults ?? DEFAULTS),
				),
			};
		},
		{
			// Present in the workspace: an answer on its own thing (item 88), as the things plugin's lists admit.
			admit: ({ workspace }, principal, self) => {
				const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
				return self.derive([gives], ([answers]) => (answers[workspace] === undefined ? NOT_PRESENT : ALLOWED));
			},
		},
	);
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

/**
 * Each defaults thing's settings, by thing (none set: `DEFAULTS`). Version 1, as Pis deployed from 7093618af stored
 * it.
 */
const SettingsV1 = defineTable("sessions.settings", {
	version: 1,
	columns: {
		thing: str(),
		defaults: json(
			obj({
				model: union([ModelChoiceV1, nul()]),
				shared: bool(),
				opensWith: union([str({ max: 200 }), nul()]),
			}),
			{ version: 1 },
		),
	},
	key: ["thing"],
});

/**
 * Version 2: the model choice names a login (decision 124); defaults of version 1 keep everything but their model,
 * so stored data survives the update (decision 125).
 */
const Settings = evolveTable(SettingsV1, (t) =>
	t.json(
		"defaults",
		// Its schema as Pis deployed it (a history is never edited in place, Astra): no location yet.
		json(obj({ model: union([ModelChoice, nul()]), shared: bool(), opensWith: union([str({ max: 200 }), nul()]) }), {
			version: 2,
			// Version 1 cells are this plugin's own writes of the same object; the column checks the result once.
			migrate: (old) => ({ ...(old as SessionDefaults), model: null }),
		}),
	),
);

/**
 * Version 3: a default location; defaults of an earlier version have none (decision 125). A cell migrates in one step
 * from the version it was written in: of version 1, its model goes too (as version 2's step did).
 */
const SettingsV3 = evolveTable(Settings, (t) =>
	t.json(
		"defaults",
		json(SessionDefaults, {
			version: 3,
			// Earlier cells are this plugin's own writes of the same object without `location`.
			migrate: (old, from) => ({
				...(old as SessionDefaults),
				...(from === 1 ? { model: null } : {}),
				location: null,
			}),
		}),
	),
);

/** Serves `DefaultsSettings` on `host`. */
function serveSettings(host: FacetHost<P3Principal>): void {
	host.serve(DefaultsSettings, (_params, self) => {
		const settings = self.table(SettingsV3);
		return {
			settings: self.queries(
				settings,
				// `defaults` holds only what `set` wrote, checked against `SessionDefaults` by `Workspace.configure`.
				{ map: ({ thing, defaults }) => ({ thing, defaults: defaults as SessionDefaults }) },
				{
					// The key.
					of: ({ thing }: { thing: string }) => query(SettingsV3).where((row) => eq(row.thing, thing)),
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
