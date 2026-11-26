// The faux inbox on the server, for tests only: its kind (`serveThing`, creation `person`, its input the sign-in its
// creation view hands over), whose `create` keeps that sign-in and `delete` drops it, in a table keyed by the thing.

import { defineFacet, defineTable, str } from "@earendil-works/p3/v1";
import { serveThing } from "@earendil-works/p3/v1/server";
import { FauxInboxKind, FauxInboxStore, FauxSignIn } from "./contract.ts";

/** Every faux inbox's sign-in, by its thing's id. */
const SignIns = defineTable("faux.inbox.sign-ins", {
	version: 1,
	columns: { thing: str(), signIn: str() },
	key: ["thing"],
	indexes: {},
});

export default defineFacet((host) => {
	host.serve(FauxInboxStore, (_params, self) => {
		const signIns = self.table(SignIns);
		return {
			signInOf: ({ thing }, ctx) => self.tx(async (tx) => (await tx.get(signIns, { thing }))?.signIn ?? null, ctx),
			keep: ({ thing, signIn }, ctx) =>
				self.tx(async (tx) => {
					tx.put(signIns, { thing, signIn });
					return null;
				}, ctx),
			drop: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(signIns, { thing });
					return null;
				}, ctx),
		};
	});
	serveThing(host, FauxInboxKind, {
		title: "Faux inbox",
		creation: "person",
		input: FauxSignIn,
		create: async (thing, input, ctx) => {
			// The input was checked against `FauxSignIn` by the sessions plugin.
			const { signIn } = input as { readonly signIn: string };
			await (await ctx.get(FauxInboxStore, {})).keep({ thing: thing.id, signIn }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(FauxInboxStore, {})).drop({ thing }, ctx);
		},
	});
});
