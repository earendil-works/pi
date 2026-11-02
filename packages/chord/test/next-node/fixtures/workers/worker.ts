// Fixture worker (slice 10): `workerMain` with a host at its address, the shipped plugins, and a core facet serving
// `Control` (crash, fatal, block, busy, local calls) and `Busy` (the app's keep-alive counts). Its start data picks a
// behaviour for the tests: exit or throw before connecting, never connect, a slow or endless load, slow closers that
// log their order to a file.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { int, local, map, method } from "../../../../src/next/contracts/index.ts";
import { defineState } from "../../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { workerMain } from "../../../../src/next-node/workers/index.ts";
import { Control, type WorkerBehaviour } from "./control.ts";

// Every IPC message this process sends, counted (a local call must send none).
let sent = 0;
const send = process.send!.bind(process) as (...args: unknown[]) => boolean;
process.send = ((...args: unknown[]) => {
	sent++;
	return send(...args);
}) as typeof process.send;

const Busy = local("test.busy", { version: 1, params: {}, members: { counts: map(int()), set: method(int()) } });
const Echo = local("test.echo", { version: 1, params: {}, members: { echo: method(int(), int()) } });
const Counts = defineState("counts", { schema: map(int()), version: 1, initial: () => ({ tasks: 0 }) });

/** The worker's host, set once made: a timer reaches its objects through it. */
let host: ReturnType<typeof createHost>;

const core = defineFacet((facet) => {
	facet.serve(Busy, (_, self) => {
		const counts = self.state(Counts);
		return {
			counts: self.derive([counts], ([value]) => value),
			set: async (n, ctx) => {
				await counts.change((draft) => {
					draft.tasks = n;
				}, ctx);
				return null;
			},
		};
	});
	facet.serve(Echo, () => ({ echo: async (n) => n }));
	facet.serve(Control, (_params, _principal, self) => {
		const busy = self.get(Busy, {});
		const echo = self.get(Echo, {});
		return {
			variant: "main",
			members: {
				crash: async (code) => {
					setTimeout(() => process.exit(code), 10);
					return null;
				},
				fatal: async (message) => {
					setTimeout(() => {
						throw new Error(message);
					}, 10);
					return null;
				},
				block: async (ms) => {
					setTimeout(() => {
						const until = Date.now() + ms;
						while (Date.now() < until) {}
					}, 10);
					return null;
				},
				blockThenCrash: async (ms) => {
					setTimeout(() => {
						const until = Date.now() + ms;
						while (Date.now() < until) {}
						process.exit(9);
					}, 10);
					return null;
				},
				busy: async (ms, ctx) => {
					await busy.set(1, ctx);
					// After the call settled (its ctx sealed, maybe this object ended): through the host.
					setTimeout(async () => {
						const counts = await host.get(Busy, {}, BACKGROUND_CONTEXT);
						await counts.set(0, BACKGROUND_CONTEXT);
						counts.release();
					}, ms);
					return null;
				},
				localCalls: async (n, ctx) => {
					const before = sent;
					for (let i = 0; i < n; i++) await echo.echo(i, ctx);
					return sent - before;
				},
			},
		};
	});
});

workerMain(
	async ({ address, start, parent, plugins, onClose }, ctx) => {
		const behaviour = start as WorkerBehaviour;
		if (behaviour.exit !== undefined) process.exit(behaviour.exit);
		if (behaviour.fatal !== undefined) throw new Error(behaviour.fatal);
		const worker = createHost({ address, principal: { kind: "worker" }, onError: () => {} });
		host = worker;
		onClose(async () => {
			if (behaviour.log !== undefined) appendFileSync(behaviour.log, "host\n");
			await worker.close(BACKGROUND_CONTEXT);
		});
		onClose(async () => {
			if (behaviour.closeMs !== undefined) await sleep(behaviour.closeMs);
			if (behaviour.log !== undefined) appendFileSync(behaviour.log, "store\n");
		});
		if (behaviour.connect === false) await sleep(1e9, undefined, { signal: ctx.abortSignal });
		worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);
		if (behaviour.loadMs !== undefined) await sleep(behaviour.loadMs, undefined, { signal: ctx.abortSignal });
		if (behaviour.hang === true) await sleep(1e9, undefined, { signal: ctx.abortSignal });
		await plugins.load(worker, { kind: "worker", core: [{ name: "@test/core", facet: core }] }, ctx);
		if (behaviour.disconnectAndBlock === true) {
			setTimeout(() => {
				// Blocks before `workerMain`'s own disconnect listener runs: the child lives on without its channel.
				process.prependOnceListener("disconnect", () => {
					const until = Date.now() + 20_000;
					while (Date.now() < until) {}
				});
				process.disconnect?.();
			}, 300);
		}
		const calls = behaviour.localCalls;
		if (calls !== undefined) {
			setTimeout(async () => {
				const echo = await worker.get(Echo, {}, BACKGROUND_CONTEXT);
				const before = sent;
				for (let i = 0; i < calls; i++) await echo.echo(i, BACKGROUND_CONTEXT);
				process.stdout.write(`local calls sent ${sent - before}\n`);
				echo.release();
			}, 300);
		}
		return { busy: (await worker.get(Busy, {}, ctx)).counts };
	},
	{
		hostPackages: { "@earendil-works/chord/next": chordNext },
		redact: (error) => ({
			message: String(error instanceof Error ? error.message : error).replace(/secret\S*/g, "[redacted]"),
		}),
		// Its errors on stderr, as an app logs them: the server keeps the tail private.
		onError: (error) => console.error(error),
	},
);
