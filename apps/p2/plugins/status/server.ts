import { num, obj } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	canView,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	PluginError,
	record,
} from "@p2/app/v1";
import { Hosts, serverOf } from "@p2/app/v1/server";
import { ReportFields, SessionMetrics, SessionStatus, type Status, StatusStore, WorkerControl } from "./contract.ts";

/** The latest report of each session's worker, with the generation that sent it. 2: `work`. */
const Reports = defineTypedState("p2.status-reports", {
	schema: obj({ reports: record(obj({ generation: num(), ...ReportFields })) }),
	version: 2,
	initial: () => ({ reports: {} }),
});

/**
 * `SessionStatus` 1: pages read statuses without `work`; a worker built then reports none (its conversations show
 * as busy without a step).
 */
const STATUS_ACCEPTS: AcceptsTable<typeof SessionStatus> = {
	1: {
		state: {
			reader: {
				statuses: (statuses) =>
					Object.fromEntries(
						Object.entries(statuses).map(([session, { work: _work, ...status }]) => [session, status]),
					),
			},
		},
		methods: { report: { args: (old) => ({ ...old, work: {} }) } },
	},
};

export default defineFacet((host) => {
	// Who looks at a session: one entry per `SessionMetrics` reference (its params name the session and the viewer).
	const metrics = host.references(SessionMetrics);

	host.serve(StatusStore, (_params, self) => {
		const reports = self.state(Reports);
		const hosts = self.get(Hosts, {});
		// Whether a worker runs comes from the workers component, what it does from its own generation's latest report.
		const statuses = deriveTyped(self, [hosts.workers, reports], ([workers, { reports: latest }]) =>
			Object.fromEntries(
				Object.entries(workers).map(([session, worker]): [string, Status] => {
					if (!worker.running)
						return [
							session,
							{
								running: false,
								tasks: 0,
								busy: [],
								work: {},
								...(worker.error ? { error: worker.error } : {}),
							},
						];
					const report = latest[session];
					if (report === undefined || report.generation !== worker.generation)
						return [session, { running: true, tasks: 0, busy: [], work: {} }];
					const { generation: _generation, ...reported } = report;
					return [session, { running: true, ...reported }];
				}),
			),
		);
		return {
			statuses,
			report: async ({ session, generation, tasks, busy, work, usage }, ctx) => {
				// A report of an older worker (one that exited while its report travelled) is dropped.
				const worker = hosts.workers.value[session];
				if (worker === undefined || !worker.running || worker.generation !== generation) return null;
				await reports.change((draft) => {
					draft.reports[session] = {
						generation,
						tasks,
						busy: [...busy].sort((a, b) => a - b),
						work,
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
				// Answers with the start's outcome: the worker runs, or the call fails with why it could not start.
				restart: async (ctx) => {
					const outcome = await server().workers.retry(session, ctx);
					if (outcome.error !== undefined) throw new PluginError("worker_failed", outcome.error);
					return null;
				},
			},
		};
	});

	host.serve(SessionMetrics, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const status = self.get(StatusStore, {});
		const clients = self.derive(
			[metrics],
			([references]) =>
				new Set(references.filter((each) => each.params.session === session).map((each) => each.params.viewer))
					.size,
		);
		const usage = deriveTyped(self, [status.statuses], ([value]) => value[session]?.usage ?? null);
		return { variant: "reader", members: { clients, usage } };
	});

	host.serve(
		SessionStatus,
		(_params, principal, self) => {
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
							const { running, tasks, busy, work, usage } = status;
							return [[session, { running, tasks, busy, work, ...(usage === undefined ? {} : { usage }) }]];
						}),
					),
				);
				return { variant: "reader", members: { statuses: statusesView } };
			}
			if (!isOwner(principal)) throw forbidden("owners and guests only");
			return { variant: "reader", members: { statuses: store.statuses } };
		},
		{ accepts: STATUS_ACCEPTS },
	);
});
