// The share store: version 1 guests keep their access, and one guest holds grants to several sessions.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ShareDb } from "../../plugins/sharing/db.ts";
import { normalizeEmail } from "../../plugins/sharing/server.ts";

test("share store upgrades version 1 guests to grants", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-shares-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const old = new DatabaseSync(join(directory, "shares.sqlite"));
	old.exec(`
		CREATE TABLE links (
			id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
			UNIQUE(session, mode)
		) STRICT;
		CREATE TABLE guests (
			id TEXT PRIMARY KEY, linkId TEXT NOT NULL, name TEXT NOT NULL, secretHash TEXT NOT NULL,
			removed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, lastSeen INTEGER NOT NULL
		) STRICT;
		INSERT INTO links VALUES ('l1', 's1', 'full', '${"a".repeat(43)}');
		INSERT INTO guests VALUES ('g1', 'l1', 'Alice', 'hash', 0, 3, 5), ('g2', 'l1', 'Bob', 'hash', 1, 2, 6);
		PRAGMA user_version=1;
	`);
	old.close();

	const db = new ShareDb(directory);
	t.after(() => db.close());
	assert.deepEqual(db.guest("g1"), { id: "g1", name: "Alice", email: null, revision: 3 });
	assert.deepEqual(db.grants("g1"), [{ session: "s1", mode: "full", linkId: "l1", removed: false, grantedAt: 5 }]);
	assert.equal(db.grants("g2")[0]?.removed, true, "a removed guest stays removed");
});

test("a guest holds several sessions; removal and link resets end one grant each", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-shares-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const db = new ShareDb(directory);
	t.after(() => db.close());
	db.link("s1", "view", false);
	db.link("s2", "full", false);
	const [first, second] = db.links();
	assert(first && second);

	const joined = db.join(first, "Bob");
	assert(joined.cookie);
	const bob = db.guestOfCookie(joined.cookie);
	assert(bob);
	assert.deepEqual(db.join(second, "ignored", bob), { guest: bob.id, changed: true }, "the same browser gains s2");
	assert.deepEqual(
		db.grants(bob.id).map(({ session, mode }) => [session, mode]),
		[
			["s1", "view"],
			["s2", "full"],
		],
	);
	assert.equal(db.guest(bob.id)?.revision, 2);
	assert.deepEqual(db.join(second, "ignored", db.guest(bob.id)), { guest: bob.id, changed: false });

	const ann = db.share("s1", "ann@example.com", "Ann@Example.com", "view");
	db.share("s2", "ann@example.com", "Ann@Example.com", "full");
	assert.equal(db.guestOfEmail("ann@example.com")?.id, ann.guest);
	assert.deepEqual(
		db.emails(() => true),
		["ann@example.com"],
	);
	assert.deepEqual(
		db.emails((session) => session !== "s1" && session !== "s2"),
		[],
		"archived sessions report nobody",
	);
	assert.equal(db.people().length, 2);

	assert.equal(db.remove("s1", ann.guest), true);
	assert.deepEqual(
		db.people().map((person) => person.session),
		["s2"],
	);
	db.share("s1", "ann@example.com", "Ann@Example.com", "view");
	assert.equal(db.people().length, 2, "sharing again gives a removed person access again");

	assert.deepEqual(db.link("s1", "view", true), [bob.id]);
	assert.deepEqual(
		db.grants(bob.id).map(({ session }) => session),
		["s2"],
		"a link reset ends only the grants made through it",
	);
});

test("emails normalize as Radius normalizes them", () => {
	assert.equal(normalizeEmail(" Ann.Example@GoogleMail.com "), "annexample@gmail.com");
	assert.equal(normalizeEmail("Bob@Bücher.example"), "bob@xn--bcher-kva.example");
	assert.equal(normalizeEmail("not an address"), null);
});
