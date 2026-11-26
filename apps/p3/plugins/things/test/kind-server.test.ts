// The kinds' test server (`kindServer`) on its own, with the notes plugin as its kind: holders a later refusal leaves
// held are released (Astra, round 3), and its close closes every worker facet it built and the host, also when one
// worker facet failed to build (Astra, round 4).

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, isChordError } from "@earendil-works/p3/v1";
import { eventually } from "../../../test/until.ts";
import { NotesKind } from "../../notes/kind.ts";
import notesServer from "../../notes/server.ts";
import { BY, kindServer } from "./kind-server.ts";

/** The notes plugin as a kind's tests start it. */
const NOTES = {
	name: "@earendil-works/p3-notes",
	root: fileURLToPath(new URL("../../notes/", import.meta.url)),
	server: notesServer,
};

describe("the kinds' test server", () => {
	it("releases the earlier holds when a later one is refused", async () => {
		const n = await kindServer(NOTES, NotesKind, context);
		try {
			const ann = await n.person("Ann");
			const dana = await n.things.createPerson({ name: "Dana", madeBy: BY }, context);
			const notebook = await n.thingIn(n.pi);
			await assert.rejects(
				n.holders([ann, { kind: "person", id: dana, name: "Dana" }], n.pi, notebook),
				(error: unknown) => isChordError(error) && error.code === "forbidden",
			);
			// Ann's object ended with her hold: holding it again opens its list again.
			await eventually(
				async () => {
					const before = n.count("chord.query.runs");
					await n.holding(ann, n.pi, notebook, async (notes) => notes.list.value);
					return n.count("chord.query.runs") - before;
				},
				(runs) => runs > 0,
				5000,
			);
		} finally {
			await n.close();
		}
	});

	it("closes every worker facet it built and the host, also when one failed to build", async () => {
		const root = await mkdtemp(join(tmpdir(), "p3-kind-server-"));
		try {
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ name: NOTES.name, private: true, type: "module" }),
			);
			const worker = join(root, "worker.ts");
			await writeFile(worker, "export default (;\n");
			const n = await kindServer({ ...NOTES, root }, NotesKind, context);
			await assert.rejects(n.worker("s1"));
			await writeFile(
				worker,
				'import { defineFacet } from "@earendil-works/p3/v1";\nexport default defineFacet(() => {});\n',
			);
			const built = await n.worker("s2");
			await n.close();
			await assert.rejects(n.thingIn(n.pi), "the host is closed");
			await assert.rejects(
				built.host.root(async () => null, context),
				"the built worker facet is closed",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
