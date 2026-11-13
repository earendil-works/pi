// Session worker host: one process per running session, forked by the server's workers component. Its host sits at the
// session's address on the session's Chord store (`<data>/sessions/<id>/store.sqlite`), connected to the server over
// IPC, and loads the worker facets the server shipped beside the core facet, which owns the session's Durable Harness
// (its records in that store), and the kit's `Files` over the session's files. While settings.json's `telemetry` is on
// (`WorkerInit.telemetry`), it records telemetry in memory (its host's, Durable's and pi-ai's spans and metrics) and
// sends it to the server's store every second, as Chord's kit worker does; off, its host uses Chord's NOOP adapter.

import { setTimeout as sleep } from "node:timers/promises";
import { isChordError } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { nodeCompression } from "@earendil-works/chord/compression";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { sendWorkerTelemetry, TelemetryRecorder } from "@earendil-works/chord/telemetry-ingest";
import { workerMain } from "@earendil-works/chord/workers/child";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { backupConfigured } from "../runtime/backup.ts";
import { createHost, hostErrorText } from "../runtime/chord.ts";
import { configureFetch } from "../runtime/fetch.ts";
import { hostFiles, openHostStore, sessionDirectory } from "../runtime/host-dirs.ts";
import { captureProcessLogs, processLogs } from "../runtime/logs.ts";
import { HOST, principalAttributes, SERVER } from "../runtime/principals.ts";
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

/** How many settled spans a worker keeps while it cannot send (past it new ones are dropped), as Chord's kit worker. */
const TELEMETRY_QUEUE = 10_000;

/** How often a worker sends what it recorded, as Chord's kit worker. */
const TELEMETRY_SEND_MS = 1000;

workerMain(
	async ({ address, start, parent, plugins, onClose }, context) => {
		const init = start as unknown as WorkerInit;
		processLogs.redactor.addDirectory(init.dataDir);
		// Keep a redacted diagnostics copy without changing the worker's actual stdout/stderr writes.
		const stopLogs = captureProcessLogs(`session:${init.values.session.id}`);
		onClose(() => stopLogs());
		// The session's directory: its store (Durable's records, its `Files` index) and its files. The store keeps an
		// outbox while backup is configured (`src/runtime/backup.ts`; turned on, it starts at the current commit and the
		// first upload is a full copy), which `plugins/backup` uploads. Closed after the host (closers run in reverse).
		const dir = sessionDirectory(init.dataDir, init.values.session.id);
		const store = await openHostStore(dir, { outbox: backupConfigured() }, context);
		onClose(() => store.close(BACKGROUND_CONTEXT));
		const scope = crypto.randomUUID();
		const recorder = init.telemetry ? new TelemetryRecorder(() => scope, TELEMETRY_QUEUE) : undefined;
		const host = createHost({
			address,
			principal: HOST,
			store,
			...(recorder === undefined ? {} : { telemetry: recorder }),
			principalAttributes,
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
						facet: workerCore(
							init,
							liveness,
							location,
							store,
							(fn, rootContext) => host.root(fn, rootContext),
							recorder,
						),
					},
					// The session's files (the kit's `Files`): `<data>/sessions/<id>/files/`.
					{ name: "chord.app.files", facet: filesFacet(hostFiles(dir)) },
				],
			},
			context,
		);
		// Held after the load (a host holds nothing before). Closers run in reverse: this one before the host closes, the
		// last spans and partial metrics sent while the link is up, for at most a second.
		if (recorder !== undefined) {
			const sender = sendWorkerTelemetry(host, recorder, context);
			const timer = setInterval(() => void sender.send(false), TELEMETRY_SEND_MS);
			timer.unref();
			onClose(async () => {
				clearInterval(timer);
				await Promise.race([sender.send(true), sleep(TELEMETRY_SEND_MS, undefined, { ref: false })]);
				sender.stop();
			});
		}
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
