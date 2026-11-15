// Reports from a worker that exits (decision "A worker's exit is published after its link's work ended"): a worker
// reports to the server and may exit at any moment. The workers component closes an exited worker's link before it
// shows the exit in its state, so a report still on its way is dropped and one being handled is aborted (its
// transaction does not commit): the server's object needs no check of its own against a worker that is gone. What it
// keeps across runs it tags with `ctx.incarnation` and compares with the incarnation in the workers' state.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/76-worker-reports/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { local, map, method, obj, str } from "../../../src/contracts/index.ts";
import { defineState } from "../../../src/documents/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
import { createWorkers } from "../../../src/node/workers/index.ts";
import { Probe, Reports, Server, Session } from "./contract.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The last report of each session, with the incarnation of the worker run that sent it. */
const Last = defineState("last", {
	schema: obj({ reports: map(obj({ text: str(), incarnation: str() })) }),
	version: 1,
	initial: () => ({ reports: {} }),
});
const Journal = local("example.journal", {
	version: 1,
	params: {},
	members: {
		reports: map(obj({ text: str(), incarnation: str() })),
		record: method(obj({ session: str(), text: str(), incarnation: str() })),
	},
});

const facet = defineFacet<{ kind: string; session?: string }>((host) => {
	host.serve(Journal, (_params, self) => {
		const last = self.state(Last);
		return {
			reports: self.derive([last], ([value]) => value.reports),
			record: async ({ session, text, incarnation }, ctx) => {
				await last.change((draft) => {
					draft.reports[session] = { text, incarnation };
				}, ctx);
				return null;
			},
		};
	});
	host.serve(Reports, (_params, principal, self) => {
		const journal = self.get(Journal, {});
		return {
			variant: "main",
			members: {
				// No check that the worker still runs: a report of a worker that exited never gets this far, or is
				// aborted before its transaction (under `ctx`) commits.
				report: async (text, ctx) => {
					await sleep(50);
					await journal.record({ session: principal.session ?? "", text, incarnation: ctx.incarnation }, ctx);
					return null;
				},
			},
		};
	});
});

const plugins = createPlugins(
	{
		roots: [],
		kinds: { worker: { platform: "node", hostPackages: ["@earendil-works/chord"] } },
		onError: console.error,
	},
	context,
);
const server = createHost<{ kind: string; session?: string }>({
	address: Server(),
	principal: { kind: "server" },
	onError: () => {},
});
const workers = createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
		execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		authorize: () => true,
		principal: (address) => ({ kind: "worker", session: address.params.id }),
		start: () => ({}),
		lock: (address) => `example-76:${process.pid}:${address.key}`,
		// The server host has no store.
		store: undefined,
		plugins,
		onError: (error) => console.log(`   reported: ${error.kind}`),
	},
	context,
);
await server.load([{ name: "@example/reports", facet }], context);

const journal = await server.get(Journal, {}, context);
const running = () => workers.state.value["session|S1"];
/** Whether the session's last report is of the worker that runs now. */
const current = () => {
	const state = running();
	const last = journal.reports.value.S1;
	return last !== undefined && state?.status === "running" && state.incarnation === last.incarnation;
};

// 1. A session's worker runs and reports: the server keeps the report with the run that sent it.
const probe = await server.get(Probe, { id: "S1" }, context);
await probe.report("indexing", context);
console.log(`1. last report: "${journal.reports.value.S1?.text}", of the running worker: ${current()}`);

// 2. It reports again and exits in the same turn. The server was still handling the report (50 ms): the worker's
//    link is closed first, the report's transaction is refused, and only then the state says the worker is gone.
probe.reportAndExit("done", context).catch(() => {});
while (running()?.status !== "failed") await sleep(10);
await sleep(200);
console.log(`2. the worker exited; last report still: "${journal.reports.value.S1?.text}"`);

// 3. Retry: another run of the worker is another incarnation, so the report kept from the earlier run is not its.
await workers.retry(Session({ id: "S1" }), context);
while (running()?.status !== "running") await sleep(10);
console.log(`3. a new worker runs; the kept report is of the running worker: ${current()}`);

probe.release();
journal.release();
await workers.close(context);
await server.close(context);
plugins.close();
