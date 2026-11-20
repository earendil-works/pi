// p3's API v1 for server facets (`@earendil-works/p3/v1/server`): Chord's HTTP surface (routes, authenticators,
// cookies), the registries the base serves (`ServerRuntime`: the server's process values; `WorkerRunners`: how a session's
// worker runs; `LinkOpened`: hooks on each accepted `/chord` link), and the contract the session route asks
// (`SessionRoute`), which a plugin serves.

import {
	type Address,
	bool,
	type ChordStore,
	defineRegistry,
	type Host,
	type Link,
	local,
	type RouteHandle,
	str,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { HttpRequest, ListenAddress } from "@earendil-works/chord/http";
import type { PluginScript, RolloutResult, RolloutStep } from "@earendil-works/chord/plugins";
import type { P3Principal } from "../../principals.ts";
import type { Session } from "./index.ts";

export * from "@earendil-works/chord/http";
export type { PluginScript, RolloutHost, RolloutResult, RolloutStep } from "@earendil-works/chord/plugins";
export * from "./control.ts";

/** The server's process values, for plugins: what only the base has. */
export type ServerRuntime = {
	/** The Pi's data directory (a real path, private). */
	readonly dataDir: string;
	readonly host: Host<P3Principal>;
	readonly store: ChordStore;
	/** The route to session workers: `retry` and `suspend` an address. */
	readonly sessions: RouteHandle<typeof Session>;
	/** How a session's worker process starts: its entry module and Node flags. */
	readonly worker: { readonly entry: string; readonly execArgv: readonly string[] };
	/** How long a worker idles before it stops itself. */
	readonly workerIdleMs: number;
	/** The worker plugins' current scripts: what a worker starts with, and what a reload ships. */
	workerScripts(context: Context): Promise<readonly PluginScript[]>;
	/** Where the server listens, once it does. */
	listening(): ListenAddress | undefined;
	/** Builds the changed plugins and rolls them out: the server, then the running workers (the runner's step). */
	apply(context: Context): Promise<RolloutResult>;
	/** Stops the server, as `SIGTERM` does. */
	stop(): void;
};

/** The server's process values (`ServerRuntime`), served by the base. */
export const ServerRuntime = defineRegistry<never, ServerRuntime>("p3.server-runtime", { version: 1 });

/** How a session's worker runs: started for the route, and the rollout step that ships plugin reloads to it. */
export type WorkerRunner = {
	/** Starts the worker of `address` (after its previous one exited) and gives the link to its host. */
	start(address: Address<typeof Session>, context: Context): Promise<Link>;
	/** Stops the worker of session `id`, if one runs; resolves once it exited. */
	stop(id: string): Promise<void>;
	/** Clears session `id`'s failure: it starts again on its next hold (now, when held). */
	retry(id: string): void;
	/** What runs: each session's worker by id, `running` or `failed` with the reason. */
	state(): Readonly<Record<string, WorkerState>>;
	readonly rollout: RolloutStep;
};

/** A session worker as its runner sees it. */
export type WorkerState =
	| { readonly status: "starting" | "running" | "stopping"; readonly pid: number }
	| { readonly status: "failed"; readonly reason: string };

/** The runners: the first contribution by plugin name is the one the route uses. */
export const WorkerRunners = defineRegistry<WorkerRunner, WorkerRunner | undefined>("p3.worker-runners", {
	version: 1,
});

/**
 * A hook on each `/chord` link the HTTP component accepts: `close` ends the link; the hook returns what to call once
 * the link closed (the sign-in plugin closes the links of a sign-in that ends).
 */
export type LinkOpenedHook = (request: HttpRequest, close: () => void) => (() => void) | undefined;

/** The hooks on accepted links, every contribution called. */
export const LinkOpened = defineRegistry<LinkOpenedHook, LinkOpenedHook>("p3.link-opened", { version: 1 });

/**
 * What the route to a session's worker asks before it starts or reaches one: whether the session exists. The API owns
 * the contract because the route is base code, which never reloads and keeps the contract it was built with; the
 * sessions plugin serves it.
 */
export const SessionRoute = local("p3.session-route", {
	version: 1,
	params: { session: str() },
	members: { exists: bool() },
});
