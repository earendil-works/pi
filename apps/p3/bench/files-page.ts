// Files' first page of a big folder (ERNDL-1173): the time `entries` takes for the first page (200 entries) of a folder
// of 10,000 files on this device, the best of 5 calls after a first one apart, as a person holding Files in Pi (the
// plugin tier: `testPlugin` of the files plugin beside the things, environments and people plugins). The work a page
// costs (one listing, one read per entry shown) is asserted in plugins/files/test/search.test.ts. Run from apps/p3
// with Node 26: node --conditions=source --disable-warning=ExperimentalWarning bench/files-page.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { MACHINE_KIND } from "../plugins/environments/contract.ts";
import environmentsServer from "../plugins/environments/server.ts";
import { seeded } from "../plugins/environments/test/seeded.ts";
import { Files, FilesKind } from "../plugins/files/kind.ts";
import peopleServer from "../plugins/people/server.ts";
import { OneThing, ThingsStore } from "../plugins/things/contract.server.ts";
import thingsServer from "../plugins/things/server.ts";

/** How many files the folder has. */
const ENTRIES = 10_000;

/** How many timed calls. */
const CALLS = 5;

const stubs = [
	{ name: "@earendil-works/p3-things", facet: thingsServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
];
const t = await testPlugin(
	fileURLToPath(new URL("../plugins/files/", import.meta.url)),
	{ kind: "server", stubs },
	context,
);
const root = await mkdtemp(join(tmpdir(), "p3-files-page-"));
try {
	const big = join(root, "big");
	await mkdir(big);
	await Promise.all(
		Array.from({ length: ENTRIES }, (_, i) => writeFile(join(big, `f${String(i).padStart(5, "0")}`), "")),
	);
	const things = await t.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const files = await seeded(await t.host.get(OneThing, { kind: FilesKind.name }, context), context);
	const machine = await seeded(await t.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
	const by = { kind: "plugin", plugin: "bench" } as const;
	const id = await things.createPerson({ name: "Ann", madeBy: by }, context);
	const party = { kind: "person", person: id } as const;
	await things.putParty({ workspace: pi, party, source: by }, context);
	await things.setGrants(
		{ source: by, grants: [{ workspace: pi, thing: files, party, tick: "browse", gives: true }] },
		context,
	);
	const took = await t.root(
		async (ctx) => {
			const held = await ctx.get(Files, { workspace: pi, thing: files });
			await held.entries!({ machine, path: big }, ctx);
			const times: number[] = [];
			for (let call = 0; call < CALLS; call++) {
				const started = performance.now();
				await held.entries!({ machine, path: big }, ctx);
				times.push(performance.now() - started);
			}
			return times;
		},
		context,
		{ principal: { kind: "person", id, name: "Ann" } },
	);
	console.log(
		`files: the first page of ${ENTRIES} entries: best ${Math.min(...took).toFixed(1)} ms (${took.map((ms) => ms.toFixed(1)).join(", ")})`,
	);
} finally {
	await t.close(context);
	await rm(root, { recursive: true, force: true });
}
