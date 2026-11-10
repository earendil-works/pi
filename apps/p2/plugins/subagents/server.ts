import {
	contribute,
	defineFacet,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	query,
	Session,
} from "@p2/app/v1";
import { Hosts, WorkerInitValues } from "@p2/app/v1/server";
import { ChildRows } from "./children.ts";
import { ChildStore, Subagents } from "./contract.ts";

/** The most sessions whose children stay live (a live query needs a bound): every session, as the catalog's. */
const WINDOW = 100_000;

export default defineFacet((host) => {
	host.serve(ChildStore, (_params, self) => {
		const hosts = self.get(Hosts, {});
		const table = self.table(ChildRows);
		const rows = self.query(table, query(ChildRows), WINDOW);
		return {
			children: deriveTyped(self, [rows], ([value]) =>
				Object.fromEntries(value.map((row) => [row.session.params.id, row.children])),
			),
			report: async ({ session, generation, children: reported }, ctx) => {
				const worker = hosts.workers.value[session];
				if (!worker?.running || worker.generation !== generation) return null;
				await self.tx((tx) => tx.put(table, { session: Session({ id: session }), children: reported }), ctx);
				return null;
			},
		};
	});

	// A worker places own cwds stored before locations existed on the environment recorded here.
	contribute(host, "p2.subagents-init", (self) => {
		const store = self.get(ChildStore, {});
		self.contribute(WorkerInitValues, {
			subagentLocations: async (session) => {
				return Object.fromEntries(
					(store.children.value[session] ?? []).flatMap((child) =>
						child.location === undefined ? [] : [[String(child.conversationId), child.location]],
					),
				);
			},
		});
	});

	host.serve(Subagents, (_params, principal, self) => {
		const store = self.get(ChildStore, {});
		if (isWorker(principal)) {
			const { session, generation } = principal;
			return {
				variant: "reporter",
				members: { report: ({ children }, ctx) => store.report({ session, generation, children }, ctx) },
			};
		}
		if (isGuest(principal)) {
			const children = deriveTyped(self, [store.children], ([value]) =>
				Object.fromEntries(Object.keys(principal.sessions).map((session) => [session, value[session] ?? []])),
			);
			return { variant: "reader", members: { children } };
		}
		if (!isOwner(principal)) throw forbidden("owners and guests only");
		return { variant: "reader", members: { children: store.children } };
	});
});
