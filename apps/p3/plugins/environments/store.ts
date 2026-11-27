// The machines store on the server (`MachinesStore`): each machine's type and settings, keyed by the machine's thing id
// (a machine is a thing of the family kind, made and linked through the things plugin; what it connects to is this
// plugin's), with a revision that changes at every write, so a connection made from older settings is known to be
// old. Server code of this plugin only: it checks nothing (the kind's create hook checks the settings).

import {
	defineTable,
	type FacetHost,
	int,
	json,
	local,
	method,
	nul,
	obj,
	type P3Principal,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";

/** A machine's type (a `MachineTypes` entry's name), its settings (that type's) and their revision. */
export const MachineRow = obj({ machine: str(), type: str(), settings: unknown(), revision: int() });

/** The machines' types and settings, once per server. */
export const MachinesStore = local("environments.machines", {
	version: 1,
	params: {},
	members: {
		/** Machine `machine`'s row; `null` when it has none (this device's seeded machine: it has none). */
		row: method(obj({ machine: str() }), union([MachineRow, nul()])),
		/** Writes machine `machine`'s type and settings, a new revision. */
		put: method(obj({ machine: str(), type: str(), settings: unknown() })),
		/** Removes machine `machine`'s row (the machine deleted). */
		remove: method(obj({ machine: str() })),
	},
});

/** Every machine's row. */
const Machines = defineTable("environments.machines", {
	version: 1,
	columns: { machine: str(), type: str(), settings: json(unknown(), { version: 1 }), revision: int() },
	key: ["machine"],
});

/** Serves `MachinesStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(MachinesStore, (_params, self) => {
		const machines = self.table(Machines);
		return {
			row: ({ machine }, ctx) => self.tx(async (tx) => (await tx.get(machines, { machine })) ?? null, ctx),
			put: ({ machine, type, settings }, ctx) =>
				self.tx(async (tx) => {
					const revision = ((await tx.get(machines, { machine }))?.revision ?? 0) + 1;
					tx.put(machines, { machine, type, settings, revision });
					return null;
				}, ctx),
			remove: ({ machine }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(machines, { machine });
					return null;
				}, ctx),
		};
	});
}
