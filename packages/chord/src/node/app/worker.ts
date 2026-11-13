// `startWorker` (slice 13 §1): a worker of an app built with the kit, in its entry module. `workerMain` plus the kit's
// part: the worker's directory under its kind and address with its store, the host at the worker's address acting as
// the principal the server gave it, connected to the server first, its plugins loaded with the kit's worker facets
// (`WorkerInfo`, `Files`, `Translations` for a worker that renders final text); when the server has a telemetry store,
// the host records in memory and sends its spans and metrics to the server every second (decision "The server is the
// one place telemetry is stored").

import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Principal } from "../../data/index.ts";
import { createHost, type PrincipalAttributes } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, sqliteBackend } from "../../store/index.ts";
import { translationsFacet } from "../../surfaces/index.ts";
import { sendWorkerTelemetry, TelemetryRecorder } from "../../telemetry-ingest/index.ts";
import type { Watchable } from "../../watch.ts";
import { workerMain } from "../workers/child.ts";
import type { AppApi, AppKind, KitStart } from "./app.ts";
import { hostDataFacet } from "./data.ts";
import { filesFacet } from "./files.ts";
import { workerInfoFacet } from "./info.ts";
import { privateDirectory, privateStore } from "./layout.ts";

/** What `startWorker` takes: the app's API and kinds as the server's `startServer` has them, this process's modules. */
export type WorkerOptions<P extends Principal = Principal> = {
	readonly api: AppApi;
	readonly kinds: Readonly<Record<string, AppKind>>;
	/** Extra keep-alive counts of the app (a record of numbers, all zero when idle). */
	readonly busy?: Watchable<Readonly<Record<string, number>>>;
	/** Who a span was for (`createHost`'s `principalAttributes`): this worker's hook, as the server's is its own. */
	readonly principalAttributes?: PrincipalAttributes<P>;
	/** The worker host's errors (`HostError`) and a failed start's. */
	readonly onError: (error: unknown) => void;
};

/** How many finished spans a worker keeps while it cannot send (past it new ones are dropped). */
const WORKER_QUEUE = 10_000;

/** How often a worker sends what it recorded. */
const WORKER_SEND_MS = 1000;

/** Runs this process as a worker of the app: once the start message arrived, its host is up and its plugins loaded. */
export function startWorker<P extends Principal>(options: WorkerOptions<P>): void {
	// The worker's facet kind comes with the start message: every kind's packages are offered, its own are imported.
	const packages = Object.assign({}, ...Object.values(options.kinds).map((kind) => kind.packages ?? {}));
	workerMain(
		async ({ address, start, parent, plugins, onClose }, context) => {
			// The server's `startServer` sends `{ kit, app }`.
			const { kit, app } = start as { readonly kit: KitStart; readonly app: JsonValue };
			await privateDirectory(kit.dir);
			await privateStore(join(kit.dir, "store.sqlite"));
			const store = await openStore(
				sqliteBackend(await openNodeSqliteDatabase(join(kit.dir, "store.sqlite"))),
				context,
			);
			onClose((ctx) => store.close(ctx));
			const scope = crypto.randomUUID();
			const recorder = kit.telemetry ? new TelemetryRecorder(() => scope, WORKER_QUEUE) : undefined;
			const { principalAttributes } = options;
			// Principals are the app's: the server made these with its `principal` options.
			const host = createHost<P>({
				address,
				principal: kit.principal as unknown as P,
				store,
				telemetry: recorder,
				...(principalAttributes === undefined ? {} : { principalAttributes }),
				...kit.timeouts,
				onError: options.onError,
			});
			onClose((ctx) => host.close(ctx));
			// First: the server sees the worker started, then the load runs.
			host.connect(parent, { principal: kit.server as unknown as P, trusted: true }, context);
			const info = {
				address: { kind: address.kind, key: address.key, params: address.params as JsonValue },
				start: app,
			};
			const core = [
				{ name: "chord.app.worker-info", facet: workerInfoFacet<P>(info) },
				{ name: "chord.app.files", facet: filesFacet<P>(join(kit.dir, "files"), kit.files, kit.uploads) },
				{
					name: "chord.app.data",
					facet: hostDataFacet<P>(store, join(kit.dir, "files"), kit.server as unknown as P),
				},
				{ name: "chord.translations", facet: translationsFacet<P>() },
			];
			await plugins.load(host, { kind: kit.facet, core }, context);
			if (recorder !== undefined) {
				const sender = sendWorkerTelemetry(host, recorder, context);
				const timer = setInterval(() => void sender.send(false), WORKER_SEND_MS);
				timer.unref();
				// Held after the load (a host holds nothing before). Closers run in reverse: this one before the host
				// closes, the last spans and partial metrics sent while the link is up, for at most a second.
				onClose(async () => {
					clearInterval(timer);
					await Promise.race([sender.send(true), sleep(WORKER_SEND_MS, undefined, { ref: false })]);
					sender.stop();
				});
			}
			return options.busy === undefined ? {} : { busy: options.busy };
		},
		{
			hostPackages: { ...options.api.modules, ...packages },
			// Worker errors are public (decision "worker errors in public"): a fixed message, never the error's own.
			redact: () => ({ message: "worker failed" }),
			onError: options.onError,
		},
	);
}
