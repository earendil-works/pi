// Session worker host: one process per running session, forked by the server's workers component. Its host sits at the
// session's address on the session's Chord store (`<data>/sessions/<id>/store.sqlite`), connected to the server over
// IPC, and loads the worker facets the server shipped beside the core facet, which owns the session's Durable Harness
// (its records in that store), and the kit's `Files` over the session's files.

import { isChordError } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { nodeCompression } from "@earendil-works/chord/compression";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { workerMain } from "@earendil-works/chord/workers/child";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createHost, hostErrorText } from "../runtime/chord.ts";
import { configureFetch } from "../runtime/fetch.ts";
import { hostFiles, openHostStore, sessionDirectory } from "../runtime/host-dirs.ts";
import { captureProcessLogs, processLogs } from "../runtime/logs.ts";
import { HOST, SERVER } from "../runtime/principals.ts";
import { follow } from "../runtime/refs.ts";
import {
	HarnessHost,
	HarnessNative,
	Liveness,
	SessionLocation,
	spawnLocation,
	type WorkerInit,
	workerCore,
} from "../runtime/worker.ts";
import { WORKER_PACKAGES } from "./host-packages.ts";

// Before any provider request: see configureFetch (Node 26 HTTP/2 sessions can wedge an origin).
configureFetch();
// OAuth flows and Bedrock through literal dynamic imports: chunks of the worker base, loaded on first use. pi-ai's
// default variable-specifier imports would load them from pi-ai's source files, outside the snapshot.
registerLazyOAuthFlows();
registerLazyBedrockProvider();

workerMain(
	async ({ address, start, parent, plugins, onClose }, context) => {
		const init = start as unknown as WorkerInit;
		processLogs.redactor.addDirectory(init.dataDir);
		// Keep a redacted diagnostics copy without changing the worker's actual stdout/stderr writes.
		const stopLogs = captureProcessLogs(`session:${init.values.session.id}`);
		onClose(() => stopLogs());
		// The session's directory: its store (Durable's records, its `Files` index) and its files. The outbox is off
		// until p2 syncs (turning it on later starts it at the current commit; a first sync uploads an archive).
		// Closed after the host (closers run in reverse).
		const dir = sessionDirectory(init.dataDir, init.values.session.id);
		const store = await openHostStore(dir, { outbox: false }, context);
		onClose(() => store.close(BACKGROUND_CONTEXT));
		const host = createHost({
			address,
			principal: HOST,
			store,
			// Large parts (a conversation's view) leave deflated; the server relays them as they are.
			compression: nodeCompression,
			onError: (error) => {
				if (!(error.kind === "activation_failed" && isChordError(error.failure.error, "released")))
					console.error(`p2 worker: ${hostErrorText(error)}`, error);
			},
		});
		const liveness = new Liveness();
		onClose(async () => {
			liveness.stop();
			await host.close(BACKGROUND_CONTEXT);
		});
		// Connect first: the server sees the worker started; the server's own requests act as SERVER, those it relays as
		// their caller.
		host.connect(parent, { principal: SERVER, trusted: true }, context);
		// Where the session works: the spawn location, then each in-place relocation (the Harness's `relocate`).
		const location = new SessionLocation(spawnLocation(init.values.session));
		await plugins.load(
			host,
			{
				kind: "worker",
				core: [
					{
						name: "@p2/core",
						facet: workerCore(init, liveness, location, store, (fn, rootContext) => host.root(fn, rootContext)),
					},
					// The session's files (the kit's `Files`): `<data>/sessions/<id>/files/`.
					{ name: "chord.app.files", facet: filesFacet(hostFiles(dir)) },
				],
			},
			context,
		);
		// A Harness that cannot open fails the worker (its error, with Retry), as an unknown root model does: at its first
		// failed attempt (`get` would retry it until its ready timeout, the start meanwhile hanging).
		const harnessHost = host.hold(HarnessHost, {}, context);
		try {
			await new Promise<void>((resolve, reject) => {
				const stop = follow(harnessHost.state, (state) => {
					if (state.kind === "live") resolve();
					else if (state.kind === "failed") reject(state.cause.error);
					else if (state.kind === "ended") reject(state.error);
					else return;
					// Called during `follow` when the state is known at once: `stop` exists only afterwards.
					queueMicrotask(() => stop());
				});
			});
		} finally {
			harnessHost.release();
		}
		// Every plugin is loaded (its extensions contributed): scheduling may start. An archived session started only to
		// rebuild its search index is scanned without resuming its work.
		const harness = (await host.registry(HarnessNative, context)).value;
		if (harness !== undefined && init.values.session.resume !== false) harness.durable.resume();
		return { busy: liveness };
	},
	{
		hostPackages: WORKER_PACKAGES,
		redact: (error) => ({
			message: processLogs.redactor.redact(error instanceof Error ? error.message : String(error)),
		}),
		onError: (error) => console.error("p2 worker:", error),
	},
);
