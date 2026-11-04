// Tests of a preference the server keeps per principal (decision "Messages and languages in the app kit" (3), the theme
// choice's pattern): each principal's pick, `none` before a choice, kept in the server's store across a restart.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createHost, hostKind, int, memoryLinkPair, openStore, sqliteBackend } from "../../src/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { preferenceContract, preferenceFacet } from "../../src/surfaces/preference.ts";

type TestPrincipal = { readonly kind: "server" } | { readonly kind: "user"; readonly id: string };

const Zoom = preferenceContract("test.zoom.choice", int({ min: 50, max: 200 }));

/** A server keeping zoom picks in the store at `path`, and a client of each of `users`. */
async function setup(path: string, users: readonly string[]) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const server = createHost<TestPrincipal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		store,
		onError: () => {},
	});
	await server.load(
		[{ name: "test.zoom", facet: preferenceFacet<TestPrincipal>(Zoom, "test.zoom.picks", int(), 100) }],
		context,
	);
	const clients = await Promise.all(
		users.map(async (id) => {
			const client = createHost<TestPrincipal>({ onError: () => {} });
			await client.load([], context);
			const [mine, theirs] = memoryLinkPair();
			server.accept(theirs, { principal: { kind: "user", id } }, context);
			client.connect(mine, { principal: { kind: "server" } }, context);
			return client;
		}),
	);
	const close = async () => {
		for (const client of clients) await client.close(context);
		await server.close(context);
		await store.close(context);
	};
	return { clients, close };
}

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("a preference per principal", () => {
	it("is none before a choice and each principal's own after", async () => {
		const dir = await mkdtemp(join(tmpdir(), "preference-"));
		const { clients, close } = await setup(join(dir, "store.db"), ["ada", "grace"]);
		const [ada, grace] = await Promise.all(clients.map((client) => client.get(Zoom, {}, context)));
		expect([ada!.pick.value, grace!.pick.value]).toEqual([100, 100]);
		await ada!.choose(150, context);
		await until(() => ada!.pick.value === 150);
		expect(grace!.pick.value).toBe(100);
		await expect(grace!.choose(500, context)).rejects.toMatchObject({ code: "invalid" });
		await close();
		await rm(dir, { recursive: true, force: true });
	});

	it("is kept in the server's store across a restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "preference-"));
		const first = await setup(join(dir, "store.db"), ["ada"]);
		const choice = await first.clients[0]!.get(Zoom, {}, context);
		await choice.choose(120, context);
		await first.close();
		const second = await setup(join(dir, "store.db"), ["ada"]);
		const again = await second.clients[0]!.get(Zoom, {}, context);
		expect(again.pick.value).toBe(120);
		await second.close();
		await rm(dir, { recursive: true, force: true });
	});
});
