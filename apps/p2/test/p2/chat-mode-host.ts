// A bare session host for chat-mode tests: the chat worker facet and the facet under test, over a real Durable
// harness in memory with the fake provider. No worker process, HTTP or SQLite.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, Harness as DurableHarness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import chatWorker from "../../plugins/chat/worker.ts";
import chatModeWorker from "../../plugins/chat-mode/worker.ts";
import { Attachments } from "../../plugins/files/contract.ts";
import { WorkerModels } from "../../plugins/models/contract.ts";
import { createP2Models } from "../../plugins/models/models.ts";
import { type Facet, Session } from "../../src/runtime/chord.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import type { HarnessParts } from "../../src/runtime/worker.ts";
import { testHost, workerFacet } from "./helpers.ts";

/** Upload IDs resolve to files named after them, in a temporary directory that is never read (no images). */
const fakeUpload = (id: string) => ({ id, name: `${id}.txt`, path: `${tmpdir()}/${id}.txt`, size: 1 });

/** `directory` holds the session's Durable SQLite file; pass the previous host's to reopen the same session. */
export async function chatModeHost(options: { facet?: Facet; directory?: string } = {}) {
	const directory = options.directory ?? mkdtempSync(join(tmpdir(), "p2-chat-mode-"));
	const context = durableContext(new AbortController().signal);
	const durable = await DurableHarness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createP2Models(true), registry: createRegistry() },
		context,
	);
	await durable.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: tmpdir() } });
	durable.resume();
	const fixture = await testHost({
		address: Session({ id: "s1" }),
		kind: "worker",
		facets: [
			// Nothing here runs tools, so the execution environment is never used.
			workerFacet({
				harness: { durable, environments: {}, relocate: async () => {} } as unknown as HarnessParts,
			}),
			chatWorker,
			options.facet ?? chatModeWorker,
		],
		stubs: [
			[Attachments, { resolve: async ({ ids }: { ids: string[] }) => ids.map(fakeUpload) }],
			// No settings.json: the owner's entries carry the default name.
			[WorkerModels, (_input, _principal, self) => ({ settings: self.state({}) })],
		],
	});
	return {
		...fixture,
		durable,
		directory,
		/** Stops the host and its harness; `remove: false` keeps the session's file for a restart. */
		close: async ({ remove = true } = {}) => {
			await fixture.close();
			await durable.close(context).catch(() => {});
			if (remove) rmSync(directory, { recursive: true, force: true });
		},
	};
}
