// Test support for the workers component (slice 10 §3, §4): a server routing `Session` to forked fixture workers, the
// fixture plugins copied into a temporary root, each address's start data (its behaviour) chosen by the test.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import { hostKind, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, type Host, type HostError } from "../../../src/next/host/index.ts";
import * as chordNext from "../../../src/next/index.ts";
import { createPlugins, type Plugins } from "../../../src/next-node/plugins/index.ts";
import { createWorkers, type Workers, type WorkersError } from "../../../src/next-node/workers/index.ts";
import { Session, type WorkerBehaviour } from "../fixtures/workers/control.ts";

/** The server's own kind. */
export const Server = hostKind("server");

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

const ENTRY = fileURLToPath(new URL("../fixtures/workers/worker.ts", import.meta.url));

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
		readonly idleMs?: number;
		readonly heartbeat?: { readonly ping?: number; readonly close?: number };
		readonly start?: (address: { readonly key: string }, context: Context) => Promise<JsonValue>;
		readonly principal?: () => TestPrincipal;
		readonly authorize?: () => boolean;
	} = {},
): Promise<Fleet> {
	const root = await mkdtemp(join(tmpdir(), "chord-workers-"));
	await cp(PLUGINS, root, { recursive: true });
	const errors: WorkersError[] = [];
	const hostErrors: HostError[] = [];
	const starts: string[] = [];
	const behaviours = new Map<string, WorkerBehaviour>();
	const output: string[] = [];
	const modules = { "@earendil-works/chord/next": chordNext };
	const plugins = createPlugins(
		{ roots: [root], kinds: { worker: { platform: "node", hostPackages: Object.keys(modules) } }, onError: () => {} },
		context,
	);
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		onError: (error) => hostErrors.push(error),
		...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
	});
	const workers = createWorkers(
		server,
		Session,
		{
			kind: "worker",
			entry: ENTRY,
			execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
			authorize: options.authorize ?? (() => true),
			principal: options.principal ?? ((address) => ({ kind: "worker", id: address.params.id }) as const),
			start: async (address, startContext) => {
				starts.push(address.key);
				if (options.start !== undefined) return options.start(address, startContext);
				return (behaviours.get(address.params.id) ?? {}) as JsonValue;
			},
			lock: (address) => `chord-test:${root}:${address.key}`,
			idleMs: () => options.idleMs ?? 60_000,
			plugins,
			onOutput: (address, stream, chunk) => {
				if (stream === "stdout") output.push(`${address.key} ${Buffer.from(chunk).toString().trim()}`);
			},
			onError: (error) => errors.push(error),
		},
		context,
	);
	await server.load([], context);
	// The worker kind's set made now (discovery, builds): the watcher marks edits from then on.
	await plugins.scripts("worker", context);
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
		label: (label) => writeFile(join(root, "notes", "label.ts"), `export const label = ${JSON.stringify(label)};\n`),
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

export { context, Session };
