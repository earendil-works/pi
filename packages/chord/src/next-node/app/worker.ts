// `startWorker` (slice 13 §1): a worker of an app built with the kit, in its entry module. `workerMain` plus the kit's
// part: the worker's directory under its kind and address with its store, the host at the worker's address acting as
// the principal the server gave it, connected to the server first, its plugins loaded with the kit's worker facets
// (`WorkerInfo`, `Files`).

import { join } from "node:path";
import type { JsonValue } from "../../json.ts";
import type { Principal } from "../../next/data/index.ts";
import { createHost } from "../../next/host/index.ts";
import { openStore, sqliteBackend } from "../../next/store/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import type { Watchable } from "../../watch.ts";
import { workerMain } from "../workers/index.ts";
import type { AppApi, AppKind, KitStart } from "./app.ts";
import { filesFacet } from "./files.ts";
import { workerInfoFacet } from "./info.ts";
import { privateDirectory, privateStore } from "./layout.ts";

/** What `startWorker` takes: the app's API and kinds as the server's `startApp` has them, this process's modules. */
export type WorkerOptions = {
	readonly api: AppApi;
	readonly kinds: Readonly<Record<string, AppKind>>;
	/** Extra keep-alive counts of the app (a record of numbers, all zero when idle). */
	readonly busy?: Watchable<Readonly<Record<string, number>>>;
	/** The worker host's errors (`HostError`) and a failed start's. */
	readonly onError: (error: unknown) => void;
};

/** Runs this process as a worker of the app: once the start message arrived, its host is up and its plugins loaded. */
export function startWorker<P extends Principal>(options: WorkerOptions): void {
	// The worker's facet kind comes with the start message: every kind's packages are offered, its own are imported.
	const packages = Object.assign({}, ...Object.values(options.kinds).map((kind) => kind.packages ?? {}));
	workerMain(
		async ({ address, start, parent, plugins, onClose }, context) => {
			// The server's `startApp` sends `{ kit, app }`.
			const { kit, app } = start as { readonly kit: KitStart; readonly app: JsonValue };
			await privateDirectory(kit.dir);
			await privateStore(join(kit.dir, "store.sqlite"));
			const store = await openStore(
				sqliteBackend(await openNodeSqliteDatabase(join(kit.dir, "store.sqlite"))),
				context,
			);
			onClose((ctx) => store.close(ctx));
			// Principals are the app's: the server made these with its `principal` options.
			const host = createHost<P>({
				address,
				principal: kit.principal as unknown as P,
				store,
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
			];
			await plugins.load(host, { kind: kit.facet, core }, context);
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
