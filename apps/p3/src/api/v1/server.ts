// p3's API v1 for server facets (`@earendil-works/p3/v1/server`): Chord's HTTP surface, the registries the base
// serves, what a runner needs (the worker's control messages, Chord's process locks), and the built-in plugins' server
// contracts p3 promises (the stores apps manage their sessions and people with, the apps and thing kinds registries).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type Address,
	type ChordStore,
	defineRegistry,
	type Host,
	type Link,
	type RouteHandle,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { HttpRequest, ListenAddress } from "@earendil-works/chord/http";
import type { JsonValue } from "@earendil-works/chord/json";
import type { PluginScript, RolloutResult, RolloutStep } from "@earendil-works/chord/plugins";
import type { P3Principal } from "../../app.ts";
import type { Session } from "./index.ts";

export * from "@earendil-works/chord/http";
export type { PluginScript, RolloutHost, RolloutResult, RolloutStep } from "@earendil-works/chord/plugins";
// Chord's sync layer, for the backup plugin's server facet: targets and the relay.
export {
	FileSystemSyncRemote,
	type JsonObject,
	type PutBatchResult,
	type SessionSyncStore,
	SYNC_PROTOCOL,
	type SyncBody,
} from "@earendil-works/chord/sync";
export {
	/** Removes a lock file a killed holder left (macOS, the BSDs); only the one starter of the lock's holders calls it. */
	clearStaleLock,
	/** Takes the lock of a name (a session's), owned by the kernel for the holder's life; waits while another holds it. */
	processLock,
} from "@earendil-works/chord/workers/child";
// A machine's files and commands, for the machine plugins' server facets (this device's host) and Files.
export type { ExecutionEnv, FileError, FileInfo, Result } from "@earendil-works/pi-durable/env";
export { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
export * from "../../../plugins/apps/contract.server.ts";
export * from "../../../plugins/environments/contract.server.ts";
export * from "../../../plugins/people/contract.server.ts";
export * from "../../../plugins/sessions/contract.server.ts";
export * from "./control.ts";

/** The server's process values, for plugins: what only the base has. */
export type ServerRuntime = {
	/** The Pi's data directory (a real path, private). */
	readonly dataDir: string;
	/** The machine the server runs on: its OS user's name and its host name (what the owner and this device are first named). */
	readonly machine: { readonly user: string; readonly hostname: string };
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
	/** Stops the server, as `SIGTERM` does (the control plugin's command `stop`). */
	stop(): void;
};

/** The server's process values (`ServerRuntime`), served by the base. */
export const ServerRuntime = defineRegistry<never, ServerRuntime>("p3.server-runtime", { version: 1 });

/** How a session's worker runs: started for the route, and the workers step of an apply, which ships reloads to it. */
export type WorkerRunner = {
	/** Starts the worker of `address` (after its previous one exited) and gives the link to its host. */
	start(address: Address<typeof Session>, context: Context): Promise<Link>;
	/** Stops the worker of session `id`, if one runs; resolves once it exited. */
	stop(id: string): Promise<void>;
	/** Clears session `id`'s failure: it starts again on its next hold (now, when held). */
	retry(id: string): void;
	/** What runs: each session's worker by id, `running` or `failed` with the reason. */
	state(): Readonly<Record<string, WorkerState>>;
	/**
	 * The process ids of every worker process it started that has not exited yet (starting, running, stopping, one that
	 * said it leaves), also while it closes: what `p3 stop` kills when the server does not stop.
	 */
	pids(): readonly number[];
	/** The workers step of an apply (the base names it and runs it after the server step): ships the changed scripts. */
	reload: RolloutStep["reload"];
};

/**
 * A session worker as its runner sees it. A starting one `waiting` for `"lock"` has not said yet that it holds its
 * session's lock: the session's previous worker may still run.
 */
export type WorkerState =
	| { readonly status: "starting"; readonly pid: number; readonly waiting?: "lock" }
	| { readonly status: "running" | "stopping"; readonly pid: number }
	| { readonly status: "failed"; readonly reason: string };

/**
 * The one runner (the runner plugin's): the base composes the wraps (`WorkerRunnerWraps`) over it. A second
 * contribution is a misconfiguration: reported as a conflict naming both plugins, and not used (the first by plugin
 * name is). To change how workers run, contribute a wrap, never a second runner.
 */
export const WorkerRunners = defineRegistry<WorkerRunner, WorkerRunner | undefined>("p3.worker-runners", {
	version: 1,
});

/**
 * A change of how session workers run: given the runner beneath it (the one runner, or it with the wraps before this
 * one), the runner the base uses instead. The base composes it again only when the runner or a wrap changes (a reload
 * of the runner plugin, an apply): what a wrap keeps (the workers it runs elsewhere) lives in its contributing object,
 * not in the runner it returns. A wrap that runs some sessions elsewhere answers `pids()` for its own workers plus
 * `inner.pids()`, and `state()` for both.
 */
export type WorkerRunnerWrap = (inner: WorkerRunner) => WorkerRunner;

/**
 * The wraps of the one runner, in plugin order: the first wraps the runner, the next wraps that. The route, the
 * status's pids (`p3 stop`) and the apply's workers step use the composed runner.
 */
export const WorkerRunnerWraps = defineRegistry<WorkerRunnerWrap, readonly WorkerRunnerWrap[]>(
	"p3.worker-runner-wraps",
	{ version: 1 },
);

/**
 * A hook on each `/chord` link the HTTP component accepts: `close` ends the link; the hook returns what to call once
 * the link closed (the sign-in plugin closes the links of a sign-in that ends).
 */
export type LinkOpenedHook = (request: HttpRequest, close: () => void) => (() => void) | undefined;

/** The hooks on accepted links, every contribution called. */
export const LinkOpened = defineRegistry<LinkOpenedHook, LinkOpenedHook>("p3.link-opened", { version: 1 });

/**
 * A command the owner's `p3` runs on the server over the data directory's socket (`server.sock`: the control plugin's
 * `stop` and `apply`, the sign-in plugin's `owner-link`). Only the owner's OS user can reach that socket (the directory
 * is private; POSIX only, Windows: ERNDL-1059): a command runs for the owner, without a sign-in, for every process of
 * that user (an agent's tools included). Its answer is sent as JSON.
 */
export type ServerCommand = { readonly name: string; run(context: Context): Promise<JsonValue> };

/** The server's commands by name: the first contribution of a name by plugin name; a second is reported. */
export const ServerCommands = defineRegistry<ServerCommand, ReadonlyMap<string, ServerCommand>>("p3.server-commands", {
	version: 1,
});

/** A fresh random token of `bytes` bytes, base64url. */
export function newToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

/** The hash a token is kept as (SHA-256, hex): what leaks from a store is no credential. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` hashes to `hash`, compared in constant time. */
export function matchesHash(token: string, hash: string): boolean {
	const given = Buffer.from(hashToken(token), "hex");
	const kept = Buffer.from(hash, "hex");
	return given.length === kept.length && timingSafeEqual(given, kept);
}
