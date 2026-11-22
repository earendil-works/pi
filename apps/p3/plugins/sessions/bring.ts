// What a writer of a session brings into it of their own (`BringThings`): the records their kinds' plugins say are
// theirs (`ThingKinds`' `records`, asked at each call: a record they no longer have cannot be brought), added as
// things brought by them; and withdrawing and setting the options of what they brought (the owner: of any thing). The
// caller's identity comes from the principal here: this plugin is the access authority. Admitted by `admitSession`: a
// reader gets no methods.

import {
	admitSession,
	type Bringer,
	BringThings,
	type Ctx,
	type FacetHost,
	forbidden,
	invalid,
	type P3Principal,
	reportError,
	type ThingRecord,
} from "@earendil-works/p3/v1";
import {
	PeopleStore,
	type RecordsFor,
	SessionsStore,
	type ThingKindEntry,
	ThingKinds,
} from "@earendil-works/p3/v1/server";

/** Serves `BringThings` on `host`. */
export function serveBring(host: FacetHost<P3Principal>): void {
	host.serve(
		BringThings,
		({ session }, principal, { access }, self) => {
			if (access === "read") return { variant: "reader", members: {} };
			// The server and workers bring nothing.
			if (principal.kind !== "person") throw forbidden("sessions: persons bring things");
			const who: RecordsFor = { kind: "person", id: principal.id };
			const by: Bringer = who;
			const store = self.get(SessionsStore, {});
			const kinds = self.registry(ThingKinds);
			// Whether the caller is the owner, read live from their row.
			const found = self.liveQuery(self.get(PeopleStore, {}).persons.one, { id: who.id }, { first: 1 });
			/** Thing `thing` of the session, which the caller brought (the owner: any). */
			const theirs = async (thing: string, ctx: Ctx<P3Principal>) => {
				const [row] = (await store.things.one.page({ session, thing }, 1, ctx)).items;
				if (row === undefined) throw invalid("args", `sessions: session ${session} has no thing ${thing}`);
				if (found.value.rows[0]?.owner === true) return;
				if (row.by.kind !== "person" || row.by.id !== who.id) {
					throw forbidden("sessions: a thing someone else brought");
				}
			};
			return {
				variant: "writer",
				members: {
					kinds: async (_args, ctx) => offered(kinds.value, who, ctx),
					bring: async ({ kind, ref, options }, ctx) => {
						const entry = kinds.value.get(kind)?.value;
						if (entry?.records === undefined) throw invalid("args", `sessions: ${kind} has no records to bring`);
						const records = await entry.records(who, ctx);
						if (!records.some((record) => record.ref === ref)) throw forbidden("sessions: not a record of yours");
						return store.addThing({ session, thing: { kind, ref, options }, by }, ctx);
					},
					withdraw: async ({ thing }, ctx) => {
						await theirs(thing, ctx);
						return store.removeThing({ session, thing }, ctx);
					},
					setOptions: async (args, ctx) => {
						await theirs(args.thing, ctx);
						return store.setOptions({ session, ...args }, ctx);
					},
				},
			};
		},
		{ admit: admitSession },
	);
}

/**
 * Every kind of `table` with records, with the ones `who` may bring, by title. A kind's `records` is untrusted code:
 * one that throws is reported and left out.
 */
async function offered(
	table: ReadonlyMap<string, { readonly value: ThingKindEntry; readonly plugin: string }>,
	who: RecordsFor,
	ctx: Ctx<P3Principal>,
): Promise<{ kind: string; title: string; records: ThingRecord[] }[]> {
	const kinds: { kind: string; title: string; records: ThingRecord[] }[] = [];
	for (const { value, plugin } of table.values()) {
		if (value.records === undefined) continue;
		try {
			const records = await value.records(who, ctx);
			kinds.push({ kind: value.kind.name, title: value.title, records: [...records] });
		} catch (error) {
			reportError(`p3 sessions: ${plugin}'s records of ${value.kind.name}`, error, ctx);
		}
	}
	return kinds.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
