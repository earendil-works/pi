// A reload of the terminals plugin while a terminal runs (Opus's round-1 repro): the program lives on the environments
// plugin's terminal host, so the reload kills nothing and the reloaded plugin lists the terminal again. The host is
// built by hand (the server's core facet, the plugins' server facets and a stand-in machine whose programs are fakes),
// as `host.reload` needs a host of its own.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createHost, openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { defineFacet, type P3Principal, Server, until } from "@earendil-works/p3/v1";
import type { ServerRuntime } from "@earendil-works/p3/v1/server";
import { MachineHosts, type PtyOptions } from "../plugins/environments/contract.server.ts";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import environmentsServer from "../plugins/environments/server.ts";
import peopleServer from "../plugins/people/server.ts";
import { Terminals, TerminalsKind } from "../plugins/terminals/contract.ts";
import terminalsServer from "../plugins/terminals/server.ts";
import { OneThing, ThingsStore } from "../plugins/things/contract.server.ts";
import thingsServer from "../plugins/things/server.ts";
import { serverCoreFacet } from "../src/server.ts";
import { within } from "./until.ts";

describe("a reload of the terminals plugin", () => {
	it("kills no running terminal, and lists it again", async () => {
		const killed: string[] = [];
		const fake = defineFacet((_host, self) => {
			self.contribute(MachineHosts, () => ({
				env: undefined as never,
				hidden: [],
				listNames: async () => [],
				createFile: () => Promise.reject(new Error("no files here")),
				openPty: async (options: PtyOptions) => ({
					write: () => {},
					resize: () => {},
					close: () => void killed.push(options.cwd),
					exited: new Promise<number>(() => {}),
				}),
			}));
		});
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(":memory:"))), context);
		const errors: unknown[] = [];
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store,
			onError: (error) => void errors.push(error),
		});
		const dataDir = await mkdtemp(join(tmpdir(), "p3-terminals-reload-"));
		// The core facet reads only these of the runtime.
		const runtime = { dataDir, host, store, machine: { user: "o", hostname: "h" } } as unknown as ServerRuntime;
		let facets = [
			{ name: "p3.server", facet: serverCoreFacet(runtime) },
			{ name: "@earendil-works/p3-a-fake", facet: fake },
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-people", facet: peopleServer },
			{ name: "@earendil-works/p3-terminals", facet: terminalsServer },
			{ name: "@earendil-works/p3-things", facet: thingsServer },
		];
		const terminalsHere = async <T>(fn: (terms: Awaited<ReturnType<typeof held>>) => Promise<T>) =>
			host.root(async (ctx) => fn(await held(ctx)), context);
		const held = async (ctx: Parameters<Parameters<typeof host.root>[0]>[0]) => {
			const things = await ctx.get(ThingsStore, {});
			const pi = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
			const thing = (await ctx.get(OneThing, { kind: TerminalsKind.name })).thing.value;
			const machine = (await ctx.get(OneThing, { kind: MACHINE_KIND })).thing.value;
			return { terms: await ctx.get(Terminals, { workspace: pi, thing }), machine, ctx };
		};
		try {
			assert.deepEqual((await host.load(facets, context)).failed, []);
			await terminalsHere(({ terms, machine, ctx }) =>
				terms.open!({ machine, folder: "/srv/test-watcher", columns: 80, rows: 24 }, ctx),
			);
			// An edit of the terminals plugin (a new facet object), applied while the terminal runs.
			facets = facets.map((p) => (p.name === "@earendil-works/p3-terminals" ? { ...p, facet: { ...p.facet } } : p));
			assert.deepEqual((await host.reload(facets, context)).failed, []);
			await terminalsHere(({ terms, ctx }) =>
				until(terms.terminals!, (list) => list.length === 1, within("the terminal listed again", ctx)),
			);
			assert.deepEqual(killed, []);
			// This host serves no HTTP component: the routes' registry is the one thing missing.
			assert.deepEqual(
				errors.filter((error) => (error as { registry?: string }).registry !== "chord.http"),
				[],
			);
		} finally {
			await host.close(context);
			await store.close(context);
			await rm(dataDir, { recursive: true, force: true });
		}
		assert.deepEqual(killed, ["/srv/test-watcher"], "the host's end ends it");
	});
});
