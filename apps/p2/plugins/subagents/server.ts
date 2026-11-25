import {
	contribute,
	defineFacet,
	deriveTyped,
	forbidden,
	grantBy,
	isGuest,
	isOwner,
	isWorker,
	notGranted,
	query,
	Session,
} from "@p2/app/v1";
import { Hosts, WorkerInitValues } from "@p2/app/v1/server";
import { ChildRows } from "./children.ts";
import { type Child, ChildStore, Subagents } from "./contract.ts";

/** The most sessions whose children stay live (a live query needs a bound): every session, as the catalog's. */
const WINDOW = 100_000;

/** A child as a guest sees it: its failure without the detail. */
const withoutDetail = (child: Child): Child =>
	child.failure?.detail === undefined ? child : { ...child, failure: { reason: child.failure.reason } };

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

	host.serve(
		Subagents,
		(_params, principal, _admitted, self) => {
			const store = self.get(ChildStore, {});
			if (isWorker(principal)) {
				const { session, generation } = principal;
				return {
					report: ({ children }, ctx) => store.report({ session, generation, children }, ctx),
					children: notGranted,
				};
			}
			if (isGuest(principal)) {
				// A failure's reason, never its detail (an error's text: paths, stacks), as status keeps the worker's error.
				const children = deriveTyped(self, [store.children], ([value]) =>
					Object.fromEntries(
						Object.keys(principal.sessions).map((session) => [
							session,
							(value[session] ?? []).map(withoutDetail),
						]),
					),
				);
				return { children: () => children, report: notGranted };
			}
			if (!isOwner(principal)) throw forbidden("owners and guests only");
			return { children: () => store.children, report: notGranted };
		},
		{ admit: grantBy((principal) => (isWorker(principal) ? ["report"] : ["children"])) },
	);
});
