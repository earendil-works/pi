// Test support for the workers component (slice 10 §3, §4): a server routing `Session` to forked fixture workers, the
// fixture plugins copied into a temporary root, each address's start data (its behaviour) chosen by the test.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { remote, str } from "../../../src/contracts/index.ts";
import { createHost, type Host, type HostError, type PluginFacet } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import { createPlugins, type Plugins } from "../../../src/node/plugins/index.ts";
import {
	createWorkers,
	type Workers,
	type WorkersError,
	type WorkersOptions,
} from "../../../src/node/workers/index.ts";
import type { Store } from "../../../src/store/index.ts";
import { Server, Session, type WorkerBehaviour } from "../fixtures/workers/control.ts";
import { settleFileEvents } from "../plugins/support.ts";

/** The fixture plugin's notes at a worker. */
export const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { label: str() } } },
});

/** The principals of these tests. */
export type TestPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly id: string }
	| { readonly kind: "guest"; readonly id: string };

/** The fixture worker's entry. */
export const ENTRY = fileURLToPath(new URL("../fixtures/workers/worker.ts", import.meta.url));

const PLUGINS = fileURLToPath(new URL("../fixtures/workers/plugins/", import.meta.url));

const made: { readonly root: string; readonly close: () => Promise<void> }[] = [];

afterEach(async () => {
	for (const { root, close } of made.splice(0)) {
		await close();
		await rm(root, { recursive: true, force: true });
	}
});

/** A server with workers; closed after the test. */
export type Fleet = {
	readonly server: Host<TestPrincipal>;
	readonly workers: Workers<typeof Session>;
	readonly plugins: Plugins;
	/** The copy of the fixture plugins. */
	readonly root: string;
	readonly errors: WorkersError[];
	readonly hostErrors: HostError[];
	/** The addresses `start` ran for, in order. */
	readonly starts: string[];
	/** The workers' stdout lines, each with its address key. */
	readonly output: string[];
	/** Each address's behaviour (its start data); none: a plain worker. */
	readonly behaviours: Map<string, WorkerBehaviour>;
	/** Writes `label` into the copy's notes plugin. */
	label(label: string): Promise<void>;
};

/** Starts a server routing `Session` to fixture workers; `options` override the workers' defaults. */
export async function fleet(
	options: {
		readonly entry?: string;
		readonly idleMs?: number;
		readonly heartbeat?: { readonly ping?: number; readonly close?: number };
		readonly start?: (address: { readonly key: string }, context: Context) => Promise<JsonValue>;
		readonly principal?: () => TestPrincipal;
		readonly authorize?: () => boolean;
		/** The route's admission, passed through `createWorkers` (slice 14 §2.3). */
		readonly admit?: WorkersOptions<TestPrincipal, typeof Session>["admit"];
		/** The server's facets (none by default). */
		readonly facets?: readonly PluginFacet<TestPrincipal>[];
		/** The server's store, given to its host and to the workers component. */
		readonly store?: Store;
		/** Called with each error of the component as it is reported (also collected in `errors`). */
		readonly onError?: (error: WorkersError) => void;
	} = {},
): Promise<Fleet> {
	const root = await mkdtemp(join(tmpdir(), "chord-workers-"));
	await cp(PLUGINS, root, { recursive: true });
	await settleFileEvents();
	const errors: WorkersError[] = [];
	const hostErrors: HostError[] = [];
	const starts: string[] = [];
	const behaviours = new Map<string, WorkerBehaviour>();
	const output: string[] = [];
	const modules = { "@earendil-works/chord": chord };
	const plugins = createPlugins(
		{ roots: [root], kinds: { worker: { platform: "node", hostPackages: Object.keys(modules) } }, onError: () => {} },
		context,
	);
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		onError: (error) => hostErrors.push(error),
		...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
		...(options.store === undefined ? {} : { store: options.store }),
	});
	const workers = createWorkers(
		server,
		Session,
		{
			kind: "worker",
			entry: options.entry ?? ENTRY,
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
			authorize: options.authorize ?? (() => true),
			...(options.admit === undefined ? {} : { admit: options.admit }),
			principal: options.principal ?? ((address) => ({ kind: "worker", id: address.params.id }) as const),
			start: async (address, startContext) => {
				starts.push(address.key);
				if (options.start !== undefined) return options.start(address, startContext);
				return (behaviours.get(address.params.id) ?? {}) as JsonValue;
			},
			lock: (address) => `chord-test:${root}:${address.key}`,
			idleMs: () => options.idleMs ?? 60_000,
			store: options.store,
			plugins,
			onOutput: (address, stream, chunk) => {
				if (stream === "stdout") output.push(`${address.key} ${Buffer.from(chunk).toString().trim()}`);
			},
			onError: (error) => {
				errors.push(error);
				options.onError?.(error);
			},
		},
		context,
	);
	await server.load(options.facets ?? [], context);
	// The worker kind's set made now (discovery, builds): the watcher marks edits from then on.
	await plugins.scripts("worker", context);
	await settleFileEvents();
	const close = async () => {
		await workers.close(context);
		await server.close(context);
		plugins.close();
	};
	made.push({ root, close });
	return {
		server,
		workers,
		plugins,
		root,
		errors,
		hostErrors,
		starts,
		output,
		behaviours,
		label: async (label) => {
			await writeFile(join(root, "notes", "label.ts"), `export const label = ${JSON.stringify(label)};\n`);
			await settleFileEvents();
		},
	};
}

/** Waits until `ready()` holds, polling every 10 ms, for at most `ms`. */
export async function until(ready: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("until: timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export { context, Server, Session };
