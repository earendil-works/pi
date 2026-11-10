// `npm run migrate-data` moves the share links, guests and grants (`shares.sqlite`, version 1 here: one guest per link)
// and the subagent lists (`subagents.sqlite`, a child with an own cwd from before locations) into the server's Chord
// store: the server refuses the old files, a dry run changes nothing, the move is verified and backed up, and a second
// run finds nothing to do. The server then lists the children and authenticates the guest's cookie as before.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Shares } from "../../plugins/sharing/contract.ts";
import { ChildStore } from "../../plugins/subagents/contract.ts";
import { migrateData } from "../../scripts/migrate-data.ts";
import { startServer } from "../../src/hosts/server.ts";

const SECRET = "c".repeat(64);
const TOKEN = "t".repeat(43);

test("migrate-data moves shares.sqlite and subagents.sqlite into the server's store, once", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "p2-server-data-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });

	// The catalog, so the session is known (its environment places the old child).
	const catalog = new DatabaseSync(join(dataDir, "catalog.sqlite"));
	catalog.exec(`CREATE TABLE sessions (
		id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT, title TEXT NOT NULL,
		createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER,
		pinned INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, thinkingLevel TEXT NOT NULL,
		titleEdited INTEGER NOT NULL DEFAULT 0, main INTEGER NOT NULL DEFAULT 1, branches TEXT NOT NULL DEFAULT '[]'
	) STRICT; PRAGMA user_version=4;
	INSERT INTO sessions (id,cwd,env,title,createdAt,updatedAt,model,thinkingLevel)
		VALUES ('s1','/w','gpu','Shared',1,1,'{"provider":"faux","modelId":"faux-1"}','off');`);
	catalog.close();

	// Version 1 shares: one guest per link, removed or not.
	const shares = new DatabaseSync(join(dataDir, "shares.sqlite"));
	shares.exec(`
		CREATE TABLE links (
			id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL, token TEXT NOT NULL UNIQUE, UNIQUE(session, mode)
		) STRICT;
		CREATE TABLE guests (
			id TEXT PRIMARY KEY, linkId TEXT NOT NULL, name TEXT NOT NULL, secretHash TEXT NOT NULL,
			removed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, lastSeen INTEGER NOT NULL
		) STRICT;
		INSERT INTO links VALUES ('l1', 's1', 'full', '${TOKEN}');
		INSERT INTO guests VALUES
			('g1', 'l1', 'Alice', '${createHash("sha256").update(SECRET).digest("hex")}', 0, 3, 5),
			('g2', 'l1', 'Bob', 'hash', 1, 2, 6);
		PRAGMA user_version=1;
	`);
	shares.close();

	// A child stored with an own cwd (version 1 of `ChildStore`), and a one-shot agent.
	const subagents = new DatabaseSync(join(dataDir, "subagents.sqlite"));
	subagents.exec("CREATE TABLE children(session TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
	subagents.prepare("INSERT INTO children VALUES (?, ?)").run(
		"s1",
		JSON.stringify([
			{
				name: "helper",
				conversationId: 7,
				model: "faux/faux-1",
				thinkingLevel: "off",
				tools: ["read"],
				cwd: "/w/sub",
				lastEntryId: 9,
			},
			{
				name: "agent",
				kind: "agent",
				conversationId: 8,
				model: "faux/faux-1",
				thinkingLevel: "off",
				tools: [],
				lastEntryId: 10,
			},
		]),
	);
	subagents.close();

	// Refused until migrated; a dry run changes nothing.
	await assert.rejects(startServer({ dataDir, port: 0, fake: true, web: false }), /migrate-data/);
	const dry = await migrateData({ dataDir, dryRun: true });
	assert.deepEqual(dry.serverData, {
		shares: { kind: "migrated", rows: 1 + 2 + 2 },
		subagents: { kind: "migrated", rows: 1 },
	});
	assert.ok(existsSync(join(dataDir, "shares.sqlite")) && existsSync(join(dataDir, "subagents.sqlite")));

	const migrated = await migrateData({ dataDir, dryRun: false });
	assert.deepEqual(migrated.serverData, dry.serverData);
	for (const file of ["shares.sqlite", "subagents.sqlite"]) {
		assert.equal(existsSync(join(dataDir, file)), false, file);
		assert.ok(existsSync(join(dataDir, "pre-server-data-backup", file)), file);
	}
	assert.deepEqual((await migrateData({ dataDir, dryRun: false })).serverData, {
		shares: { kind: "absent" },
		subagents: { kind: "absent" },
	});

	const server = await startServer({ dataDir, port: 0, fake: true, web: false });
	try {
		await server.host.root(async (ctx) => {
			// The children, the old one placed on its session's environment.
			const children = (await ctx.get(ChildStore, {})).children.value.s1 ?? [];
			assert.deepEqual(
				children.map(({ name, location }) => [name, location ?? null]),
				[
					["helper", { cwd: "/w/sub", env: "gpu" }],
					["agent", null],
				],
			);
			// The guest's cookie still authenticates, with its grant and revision; the removed one stays removed.
			const store = await ctx.get(Shares, {});
			const alice = await store.authenticate({ cookie: `g1.${SECRET}` }, ctx);
			assert.deepEqual(
				alice && { id: alice.id, name: alice.name, sessions: alice.sessions, revision: alice.revision },
				{ id: "g1", name: "Alice", sessions: { s1: "full" }, revision: 3 },
			);
			assert.equal(await store.grant({ id: "g2" }, ctx), null, "a removed guest stays removed");
			assert.deepEqual(
				store.links.value.map(({ session, mode, token }) => [session, mode, token]),
				[["s1", "full", TOKEN]],
			);
		}, BACKGROUND_CONTEXT);
	} finally {
		await server.close();
	}
});
