// The environments plugin on the server: the environments, one table (`EnvironmentsStore`), and the owner's view of
// them (`Environments`). This device is written when the store opens and finds it missing, so it exists from the
// server's first start on, once.

import { admitOwner, defineFacet, defineTable, type Environment, eq, query, str } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { EnvironmentsStore } from "./contract.server.ts";
import { Environments, THIS_DEVICE } from "./contract.ts";

/** Every environment, by id; by name for the lists. */
const Rows = defineTable("environments.rows", {
	version: 1,
	columns: { id: str(), name: str(), kind: str() },
	key: ["id"],
	indexes: { by_name: ["name"] },
});

/**
 * How many environments the owner's view reads at most: a Pi has a few. One more fails the view (closed, visible)
 * rather than leaving an environment out unseen.
 */
const SHOWN = 1000;

export default defineFacet((host) => {
	host.serve(EnvironmentsStore, (_params, self) => {
		const rows = self.table(Rows);
		const runtime = self.registry(ServerRuntime);
		// Opened before the store goes live: nobody reads the environments before this device is among them.
		self.open(
			(ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(rows, { id: THIS_DEVICE })) !== undefined) return null;
					tx.put(rows, { id: THIS_DEVICE, name: runtime.value.machine.hostname, kind: "local" });
					return null;
				}, ctx),
			() => {},
		);
		return {
			environments: self.queries(
				rows,
				// `kind` holds only what this plugin wrote: an environment's kind.
				{ map: (row) => ({ ...row, kind: row.kind as Environment["kind"] }) },
				{
					// Index `by_name`, then the key.
					all: (_args: Record<never, never>) => query(Rows).orderBy((e) => e.name, "asc"),
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((e) => eq(e.id, id)),
				},
			),
		};
	});

	host.serve(
		Environments,
		(_params, _principal, _admitted, self) => {
			const all = self.liveQuery(self.get(EnvironmentsStore, {}).environments.all, {}, { first: SHOWN });
			const environments = self.derive([all], ([{ rows, more }]) => {
				if (more) throw new Error(`environments: more than ${SHOWN} environments`);
				return rows;
			});
			return { variant: "owner", members: { environments } };
		},
		{ admit: admitOwner },
	);
});
