import { num, obj } from "@earendil-works/pi-schema";
import {
	canView,
	defineFacet,
	defineState,
	defineTypedState,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	record,
} from "@p2/app/v1";
import { Hosts, serverOf } from "@p2/app/v1/server";
import {
	SessionMetrics,
	SessionStatus,
	type Status,
	StatusesSchema,
	StatusStore,
	Viewers,
	WorkerControl,
} from "./contract.ts";

const Statuses = defineTypedState("p2.status-store", {
	schema: obj({ statuses: StatusesSchema }),
	version: 1,
	initial: () => ({ statuses: {} }),
});

const Counts = defineState("p2.session-viewers", {
	schema: obj({ counts: record(num()) }),
	version: 1,
	initial: () => ({ counts: {} }),
});

export default defineFacet((host) => {
	host.serve(StatusStore, (_params, self) => {
		const store = self.state(Statuses);
		const hosts = self.get(Hosts, {});
		// Whether a worker runs comes from the workers component; what it does, from the worker's reports.
		self.on(hosts.workers, async ({ value: workers }, ctx) => {
			await store.change((draft) => {
				for (const [session, worker] of Object.entries(workers)) {
					const current = draft.statuses[session];
					if (!worker.running) {
						draft.statuses[session] = {
							running: false,
							tasks: 0,
							busy: [],
							...(worker.error ? { error: worker.error } : {}),
						};
					} else if (current?.running !== true || current.error)
						draft.statuses[session] = { running: true, tasks: 0, busy: [] };
				}
			}, ctx);
		});
		return {
			statuses: deriveTyped(self, [store], ([value]) => value.statuses as Record<string, Status>),
			report: async ({ session, generation, tasks, busy, usage }, ctx) => {
				// A report of an older worker (one that exited while its report travelled) is dropped.
				const worker = hosts.workers.value[session];
				if (worker === undefined || !worker.running || worker.generation !== generation) return null;
				await store.change((draft) => {
					draft.statuses[session] = {
						running: true,
						tasks,
						busy: [...busy].sort((a, b) => a - b),
						...(usage ? { usage } : {}),
					};
				}, ctx);
				return null;
			},
		};
	});

	host.serve(WorkerControl, ({ session }, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Only owners may retry session workers");
		const server = serverOf(self);
		return {
			variant: "owner",
			members: {
				restart: async () => {
					await server().workers.retry(session);
					return null;
				},
			},
		};
	});

	host.serve(Viewers, (_params, self) => {
		const viewers = new Map<string, Set<string>>();
		const counts = self.state(Counts);
		return {
			counts: self.derive([counts], ([value]) => value.counts),
			enter: async ({ session, viewer }, ctx) => {
				const list = viewers.get(session) ?? new Set<string>();
				list.add(viewer);
				viewers.set(session, list);
				await counts.change((draft) => {
					draft.counts[session] = list.size;
				}, ctx);
				return null;
			},
			leave: async ({ session, viewer }, ctx) => {
				const list = viewers.get(session);
				list?.delete(viewer);
				await counts.change((draft) => {
					draft.counts[session] = list?.size ?? 0;
				}, ctx);
				return null;
			},
		};
	});
	host.serve(SessionMetrics, ({ session, viewer }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const counts = self.get(Viewers, {});
		const status = self.get(StatusStore, {});
		const server = serverOf(self);
		const clients = self.derive([counts.counts], ([value]) => value[session] ?? 0);
		const usage = deriveTyped(self, [status.statuses], ([value]) => value[session]?.usage ?? null);
		self.open(
			async () => server().root((ctx) => counts.enter({ session, viewer }, ctx)),
			async () => {
				await server()
					.root((ctx) => counts.leave({ session, viewer }, ctx))
					.catch(() => {});
			},
		);
		return { variant: "reader", members: { clients, usage } };
	});

	host.serve(SessionStatus, (_params, principal, self) => {
		const store = self.get(StatusStore, {});
		if (isWorker(principal)) {
			const { session, generation } = principal;
			return {
				variant: "reporter",
				members: { report: (report, ctx) => store.report({ ...report, session, generation }, ctx) },
			};
		}
		if (isGuest(principal)) {
			// As in Pi Mobile: whether it runs, its work and spend, never the worker's error text (paths, stacks).
			const statusesView = deriveTyped(self, [store.statuses], ([statuses]) =>
				Object.fromEntries(
					Object.keys(principal.sessions).flatMap((session) => {
						const status = statuses[session];
						if (status === undefined) return [];
						const { running, tasks, busy, usage } = status;
						return [[session, { running, tasks, busy, ...(usage === undefined ? {} : { usage }) }]];
					}),
				),
			);
			return { variant: "reader", members: { statuses: statusesView } };
		}
		if (!isOwner(principal)) throw forbidden("owners and guests only");
		return { variant: "reader", members: { statuses: store.statuses } };
	});
});
