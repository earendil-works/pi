// Real-world example for rule 1: the file-history plugin keeps every file edit of session S1 in its own SQLite
// database next to the session's log. Both sync to a desktop replica through one position sequence.
// Run: node demo.ts (Node 24). Stand-in: `log` plays session.sqlite (Durable's entries) with the same wrapper; the
// real one would take its position inside Durable's storage commit.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applyBatch, type Batch, cutBatch, SessionSqlite, Sequencer } from "./store.ts";

const root = "/tmp/session-sync-demo";
rmSync(root, { recursive: true, force: true });

function openSession(machine: string, driver: boolean) {
	const dir = join(root, machine, "sessions", "S1");
	mkdirSync(join(dir, "plugins", "file-history"), { recursive: true });
	const stores = {
		log: new SessionSqlite(join(dir, "session.sqlite")),
		history: new SessionSqlite(join(dir, "plugins", "file-history", "history.sqlite")),
	};
	// Schemas: DDL is not in changesets, so every machine runs the same versioned setup when it opens the store.
	stores.log.db.exec("CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
	stores.history.db.exec(`CREATE TABLE IF NOT EXISTS edits(
		id INTEGER PRIMARY KEY, path TEXT NOT NULL, entry INTEGER NOT NULL, before TEXT, after TEXT)`);
	// The sequencer continues above everything any store has seen (outbox or applied), also after a crash.
	const sequencer = new Sequencer(Math.max(...Object.values(stores).map((s) => s.head())) + 1);
	if (driver) for (const s of Object.values(stores)) s.attach(sequencer);
	return { stores, sequencer };
}

// ---- the plugin's code: plain SQL inside store.transaction ----
const recordEdit = (history: SessionSqlite, e: { path: string; entry: number; before: string; after: string }) =>
	history.transaction((db) =>
		db.prepare("INSERT INTO edits (path, entry, before, after) VALUES (?, ?, ?, ?)").run(e.path, e.entry, e.before, e.after),
	);
const renameDir = (history: SessionSqlite, from: string, to: string) =>
	history.transaction((db) =>
		db.prepare("UPDATE edits SET path = ? || substr(path, ?) WHERE path GLOB ?").run(to, from.length + 1, `${from}*`),
	);
const commitEntry = (log: SessionSqlite, id: number, text: string) =>
	log.transaction((db) => db.prepare("INSERT INTO entries (id, text) VALUES (?, ?)").run(id, text));

const show = (label: string, s: { stores: Record<string, SessionSqlite> }) => {
	console.log(`  ${label} entries:`, s.stores.log.db.prepare("SELECT id, text FROM entries ORDER BY id").all().map((r) => `${r.id} ${r.text}`));
	console.log(`  ${label} edits:  `, s.stores.history.db.prepare("SELECT path, entry FROM edits ORDER BY id").all().map((r) => `${r.path}@${r.entry}`));
};
const outboxes = (s: { stores: Record<string, SessionSqlite> }) =>
	Object.entries(s.stores).map(([n, st]) => `${n}: [${st.changesSince(0).map((c) => `${c.pos}(${c.change.length}B)`).join(" ")}]`).join("  ");
const upload = (b: Batch): Batch => JSON.parse(JSON.stringify(b, (_, v) => (v instanceof Uint8Array ? { b64: Buffer.from(v).toString("base64") } : v)), (_, v) => (v && typeof v === "object" && "b64" in v ? new Uint8Array(Buffer.from(v.b64, "base64")) : v));

// ---- 1. the agent works on the laptop ----
console.log("1. laptop: an agent turn writes two files, then renames a/ to b/");
const laptop = openSession("laptop", true);
commitEntry(laptop.stores.log, 811, "user: move the helpers into a/");
recordEdit(laptop.stores.history, { path: "a/x.ts", entry: 812, before: "", after: "export const x = 1;" });
recordEdit(laptop.stores.history, { path: "a/y.ts", entry: 812, before: "", after: "export const y = 2;" });
commitEntry(laptop.stores.log, 812, "tool result: wrote a/x.ts, a/y.ts");
renameDir(laptop.stores.history, "a/", "b/");
commitEntry(laptop.stores.log, 813, "tool result: renamed a/ to b/");
console.log("  outboxes:", outboxes(laptop));

// ---- 2. a transaction that dies before COMMIT leaves nothing behind ----
console.log("2. laptop: the process dies in the middle of a history transaction");
try {
	laptop.stores.history.transaction((db) => {
		db.prepare("INSERT INTO edits (path, entry, before, after) VALUES ('b/z.ts', 814, '', 'z')").run();
		throw new Error("simulated crash before COMMIT");
	});
} catch (error) {
	console.log("  ", (error as Error).message, "-> rows and record both rolled back; outboxes:", outboxes(laptop));
}

// ---- 3. upload a batch, apply it on the desktop ----
console.log("3. sync: cut at the safe position, upload, apply on the desktop in position order");
const batch = cutBatch(laptop.stores, laptop.sequencer, 0);
console.log("  batch:", batch.records.map((r) => `${r.pos}:${r.store}`).join(" "), `upTo=${batch.upTo}`);
const desktop = openSession("desktop", false);
applyBatch(desktop.stores, upload(batch));
for (const s of Object.values(laptop.stores)) s.trim(batch.upTo);
show("laptop ", laptop);
show("desktop", desktop);

// ---- 4. the naive variant: a separate outbox written after COMMIT ----
console.log("4. contrast: record appended to a separate file after COMMIT, process dies in between");
laptop.stores.history.db.prepare("INSERT INTO edits (path, entry, before, after) VALUES ('b/w.ts', 813, '', 'w')").run();
// ...appendFileSync(outbox, changeset) never runs: the row is on disk, its change exists nowhere.
console.log("  laptop edits:", laptop.stores.history.db.prepare("SELECT count(*) AS n FROM edits").get()?.n, "desktop edits:", desktop.stores.history.db.prepare("SELECT count(*) AS n FROM edits").get()?.n, "-> diverged for good, no record to resend");
laptop.stores.history.db.prepare("DELETE FROM edits WHERE path = 'b/w.ts'").run();

// ---- 5. restart and takeover ----
for (const s of Object.values(laptop.stores)) s.close();
for (const s of Object.values(desktop.stores)) s.close();
console.log("5. takeover: the desktop reopens S1 as driver; its sequencer continues above every store's head");
const driver = openSession("desktop", true);
console.log("  next position:", driver.sequencer.safeCut() + 1);
recordEdit(driver.stores.history, { path: "b/x.ts", entry: 814, before: "export const x = 1;", after: "export const x = 3;" });
commitEntry(driver.stores.log, 814, "tool result: edited b/x.ts");
console.log("  outboxes:", outboxes(driver));
