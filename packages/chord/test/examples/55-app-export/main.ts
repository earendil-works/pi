// Export and import a host's data (slice 13 §4, decision "App kit naming and export"), with example 53's notes app.
// `app.exportData` stops nothing: the project's running worker writes one archive of its own store (one consistent
// point) and files, with a manifest (app, API version, format); without a worker the server writes it.
// `app.importData` makes another address from it (refusing one that has data) and the next request starts its
// worker on the imported store and files. Archives of another app are refused.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/55-app-export/main.ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { method, obj, Project, remote, str } from "../53-app/app/v1.ts";
import { startNotes } from "../53-app/start.ts";

// The notes plugin's contract, declared again with the API's builders (contracts are data: the same name, version and
// schema bind). The plugin's own files import `@notes/app/v1`, a host package this process has no module path for.
const Notes = remote("notes.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: {
		main: {
			state: { text: str(), start: str() },
			methods: {
				write: method(str()),
				attach: method(obj({ name: str(), body: str() }), str()),
				attachment: method(str(), str()),
			},
		},
	},
});

const base = await mkdtemp(join(tmpdir(), "notes-"));
const app = await startNotes(join(base, "data"), context);

// 1. Project p1 gets a text and an attachment (its worker's store and files). The server reaches it as `Notes`.
const p1 = await app.host.get(Notes, { id: "p1" }, context);
await p1.write("the plan", context);
const attachment = await p1.attach({ name: "plan.txt", body: "step 1, step 2" }, context);
p1.release();

// 2. Export p1 while its worker runs: the worker writes the archive (mode 0600) and goes on.
const archive = join(base, "p1.tar");
await app.exportData(Project({ id: "p1" }), archive, context);
console.log(
	"1. exported:",
	`${(await stat(archive)).size} bytes`,
	`mode ${((await stat(archive)).mode & 0o777).toString(8)}`,
);

// 3. Import it as p2: a copy with p1's text and attachment, its own worker and directory.
await app.importData(archive, Project({ id: "p2" }), context);
const p2 = await app.host.get(Notes, { id: "p2" }, context);
console.log("2. p2:", JSON.stringify(p2.text.value), JSON.stringify(await p2.attachment(attachment, context)));
await p2.write("p2's own plan", context);
p2.release();
const again = await app.host.get(Notes, { id: "p1" }, context);
console.log("   p1 unchanged:", JSON.stringify(again.text.value));
again.release();

// 4. An address that has data is never overwritten.
await app
	.importData(archive, Project({ id: "p1" }), context)
	.catch((error: Error) => console.log("3. refused:", error.message.replace(base, "…")));

await app.close(context);
await rm(base, { recursive: true, force: true });
