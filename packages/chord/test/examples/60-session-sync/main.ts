// Session sync as decided (decisions S3, S5, S7, W9, "The outbox is optional, internal and versioned", "p3 meeting,
// 2026-11-02"), played with Chord's real pieces: a laptop store with an outbox, `store.outbox.read`/`trim`,
// `store.export` with `encodeJsonl`, `importStore`, and batch apply, `applyBatch` (internal: exported from
// `chord` marked internal, imported here from `src/store/apply-batch.ts`; it takes the `ChordStore` behind
// `openStore`'s `Store`). Radius and the laptop's sync client are stand-ins written for this example (`radius.ts`,
// `sync.ts`), not Chord APIs: the sync layer is not built yet (slices.md, "The sync layer").
// Steps: 1. a session on the laptop; 2. the handshake and a first upload; 3. a second sync moves only the tail;
// 4. a bootstrap from an archive for a session whose outbox was turned on late; 5. "continue on Radius" and the epoch
// fence (the split), then the same without the fence (silent divergence); 6. back to the laptop with a pull.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/60-session-sync/main.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { decodeJsonl, importStore, openStore, type Store, sqliteBackend } from "../../../src/store/index.ts";
import { RadiusStandIn } from "./radius.ts";
import { describe, withSession } from "./session.ts";
import { archiveOf, type LocalSession, pull, push, type Synced, sync } from "./sync.ts";

const radius = new RadiusStandIn();
const directory = await mkdtemp(join(tmpdir(), "chord-sync-"));

/** One sync's result as a line. */
function shown(result: Synced): string {
	switch (result.kind) {
		case "uploaded":
			return `uploaded ${result.from}..${result.to}, Radius at ${result.lastSeq}, trimmed through it`;
		case "nothing":
			return `nothing to send, Radius at ${result.lastSeq}`;
		case "bootstrapped":
			return `archive uploaded (${result.bytes} bytes), Radius imported it at ${result.lastSeq}`;
		case "behind":
			return `Radius is ahead at ${result.lastSeq}`;
		case "split":
			return `refused for an old epoch: this copy is now ${result.session.id}`;
		case "refused":
			return `refused: ${result.message}`;
	}
}

/** A new in-memory store (outbox on) imported from archive bytes. */
async function copyOf(bytes: Uint8Array): Promise<Store> {
	const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
	return importStore(backend, decodeJsonl(Readable.from([bytes])), context, { outbox: true });
}

/** Radius's view of a session as a line. */
function atRadius(id: string): string {
	const known = radius.handshake()[id]!;
	return `Radius ${id}: lastSeq ${known.lastSeq}, log ${radius.logRange(id)}, epoch ${known.epoch} (${known.driver})`;
}

try {
	// 1. The laptop: SQLite in memory with the outbox on from its first commit; one session, a few commits.
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
	const s1: LocalSession = { id: "s1", store, epoch: 1, acked: 0 };
	await withSession(store, async (session) => {
		await session.rename("Fix the parser", context);
		await session.say({ role: "user", text: "the parser drops comments" }, context);
		await session.say({ role: "assistant", text: "found it in lexer.ts" }, context);
	});
	console.log("1. laptop s1: lastSeq", store.lastSeq, "outbox floor", store.outbox!.floor);

	// 2. The handshake: Radius has no s1 (lastSeq 0), so the whole outbox goes, 1..lastSeq; then trimmed.
	console.log("2. sync:", shown(await sync(s1, radius)));
	console.log("  ", atRadius("s1"), "- laptop outbox floor", store.outbox!.floor);

	// 3. Two more commits; the next sync sends only them.
	await withSession(store, async (session) => {
		await session.say({ role: "user", text: "and strings too" }, context);
		await session.say({ role: "assistant", text: "fixed both" }, context);
	});
	console.log("3. laptop s1: lastSeq", store.lastSeq, "- sync:", shown(await sync(s1, radius)));
	console.log("  ", atRadius("s1"));
	console.log("   laptop:", await describe(store));
	console.log("   Radius:", await describe(radius.replica("s1")));

	// 4. Session s2 ran without an outbox (a file here, since it is reopened), then sync was turned on: the outbox starts
	// after its lastSeq, so Radius, which has nothing, needs an archive first; batches go on from there.
	const path = join(directory, "s2.sqlite");
	const before = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	await withSession(before, async (session) => {
		await session.rename("Release notes", context);
		await session.say({ role: "user", text: "draft the notes for 1.4" }, context);
	});
	await before.close(context);
	const store2 = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, { outbox: true });
	const s2: LocalSession = { id: "s2", store: store2, epoch: 1, acked: 0 };
	console.log(
		"4. laptop s2: lastSeq",
		store2.lastSeq,
		"outbox floor",
		store2.outbox!.floor,
		"- sync:",
		shown(await sync(s2, radius)),
	);
	await withSession(store2, async (session) => {
		await session.say({ role: "assistant", text: "here is a draft" }, context);
	});
	console.log("   laptop s2: lastSeq", store2.lastSeq, "- sync:", shown(await sync(s2, radius)));
	console.log("  ", atRadius("s2"));
	console.log("   Radius:", await describe(radius.replica("s2")));
	await store2.close(context);

	// 5. "Continue on Radius": the laptop uploads its tail (nothing left here), Radius bumps the epoch and drives,
	// writing a commit on its replica. The laptop keeps its copy as a replica and writes nothing.
	const handoff = await archiveOf(store);
	console.log(
		"5. laptop s1 sync:",
		shown(await sync(s1, radius)),
		"- Radius takes over, epoch",
		radius.takeOver("s1"),
	);
	await radius.drive("s1", (replica) =>
		withSession(replica, async (session) => {
			await session.say({ role: "assistant", text: "(on Radius) added a test" }, context);
		}),
	);
	console.log("  ", atRadius("s1"));
	// A laptop process that missed the handoff (here a copy of the laptop's store at it, so the laptop itself can take
	// the session back in step 6) writes at epoch 1 and uploads the new commit after its last acknowledgement.
	const stale: LocalSession = { id: "s1", store: await copyOf(handoff), epoch: 1, acked: 6 };
	await withSession(stale.store, async (session) => {
		await session.say({ role: "assistant", text: "(stale laptop) added a different test" }, context);
	});
	const fenced = await push(stale, radius);
	console.log("   stale laptop: lastSeq", stale.store.lastSeq, "- push:", shown(fenced));
	// The split (S7): no rollback; the copy is a new session with its origin, synced on its own from an archive.
	if (fenced.kind === "split") {
		const split = fenced.session;
		console.log(
			"   split",
			split.id,
			"origin",
			JSON.stringify(split.origin),
			"- sync:",
			shown(await sync(split, radius)),
		);
		console.log("  ", atRadius(split.id));
	}
	await stale.store.close(context);

	// 5b. The same without the epoch fence: the stale upload of seq 7 does not follow Radius's 7 and is refused, so far
	// so good; but the next handshake finds both at 7, sends nothing and trims the laptop's commit 7 as acknowledged.
	radius.checkEpochs = false;
	const unfenced: LocalSession = { id: "s1", store: await copyOf(handoff), epoch: 1, acked: 6 };
	await withSession(unfenced.store, async (session) => {
		await session.say({ role: "assistant", text: "(stale laptop) added a different test" }, context);
	});
	console.log("5b. no epoch check - stale push:", shown(await push(unfenced, radius)));
	console.log("   stale sync:", shown(await sync(unfenced, radius)), "- outbox floor", unfenced.store.outbox!.floor);
	console.log("   stale: ", await describe(unfenced.store));
	console.log("   Radius:", await describe(radius.replica("s1")));
	await unfenced.store.close(context);
	radius.checkEpochs = true;

	// 6. Back to the laptop: it takes the epoch (Radius stops driving), pulls Radius's commits after its lastSeq
	// (batch apply on the laptop's store; no host open on it), and drives again.
	s1.epoch = radius.handBack("s1", "laptop");
	const pulled = await pull(s1, radius);
	console.log(`6. laptop takes epoch ${s1.epoch}, pulls ${pulled.from}..${pulled.to}: lastSeq ${store.lastSeq}`);
	const [laptopView, radiusView] = [await describe(store), await describe(radius.replica("s1"))];
	console.log("   laptop:", laptopView);
	console.log("   Radius:", radiusView);
	console.log("   same values:", laptopView === radiusView);
	await withSession(store, async (session) => {
		await session.rename("Fix the parser (done)", context);
	});
	console.log("   laptop writes, sync:", shown(await sync(s1, radius)));
	console.log("  ", atRadius("s1"));
	console.log("   same values:", (await describe(store)) === (await describe(radius.replica("s1"))));

	await store.close(context);
} finally {
	await radius.close();
	await rm(directory, { recursive: true, force: true });
}
