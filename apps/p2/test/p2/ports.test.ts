import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { ForwardsNative, Ports } from "../../plugins/ports/contract.ts";
import { forwardOrigin, type PortsRequest } from "../../plugins/ports/protocol.ts";
import { Forwards } from "../../plugins/ports/store.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { expectChord, holdIn, http, startFixture, until } from "./helpers.ts";

const ORIGIN = "https://0123456789abcdef0123456789abcdef.rdtun.com";
const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "ports",
		),
	);
const text = (result: ToolResultMessage | undefined) =>
	(result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

test("forwards persist, validate ports, preserve ownership and invalidate removed IDs", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-forwards-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const forwards = await Forwards.open(directory);
	const [web, api] = await Promise.all([forwards.add(5173, " web ", [8788]), forwards.add(3000, undefined, [8788])]);
	assert.match(web.id, /^[a-z0-9]{10}$/);
	assert.equal(web.name, "web");
	assert.notEqual(web.id, api.id);
	await assert.rejects(forwards.add(8788, "pi", [8788]), /Pi's own port/);
	await assert.rejects(forwards.add(70000, undefined, []), /1 to 65535/);
	await assert.rejects(forwards.add(12, "x".repeat(41), []), /at most/);
	assert.deepEqual(
		(await Forwards.open(directory)).list().map((item) => item.port),
		[3000, 5173],
	);
	await forwards.setPublic(api.id, true);
	assert.equal((await Forwards.open(directory)).get(api.id)?.public, true);
	await forwards.setPublic(api.id, false);
	await forwards.remove(web.id);
	await assert.rejects(forwards.remove(web.id), /Unknown forward/);
	assert.notEqual((await forwards.add(5173, "web", [])).id, web.id);
	const own = await forwards.openForSession("one", 4000, {}, []);
	assert.equal((await forwards.openForSession("one", 4000, { public: true }, [])).id, own.id);
	// Another session may change it (Pi Mobile 67cdb4ca4): it keeps its address and its opener.
	assert.deepEqual(await forwards.openForSession("two", 4000, { public: false, name: "renamed" }, []), {
		id: own.id,
		port: 4000,
		name: "renamed",
		session: "one",
	});
	await forwards.closeSession("one");
	assert.equal(forwards.get(own.id), undefined);
	// ...and close any forward, the owner's too.
	const owners = await forwards.add(4001, undefined, []);
	assert.equal(await forwards.closePort(4001), true);
	assert.equal(forwards.get(owners.id), undefined);
	assert.equal(await forwards.closePort(4001), false);
	assert.equal(JSON.parse(await readFile(join(directory, "forwards.json"), "utf8"))[api.id].public, undefined);
	await writeFile(join(directory, "forwards.json"), '{"Bad-ID":{"port":1}}');
	await assert.rejects(Forwards.open(directory), /Invalid forwards.json/);
});

test("private/public forward origins are isolated beside the brain", () => {
	assert.equal(forwardOrigin(ORIGIN, "web1"), "https://fwd--0123456789abcdef0123456789abcdef--web1.rdtun.com");
	assert.equal(
		forwardOrigin(ORIGIN, "web1", { public: true }),
		"https://pub--0123456789abcdef0123456789abcdef--web1.rdtun.com",
	);
	assert.equal(
		forwardOrigin("http://0123456789abcdef0123456789abcdef.rdtun.localhost:8791", "web1"),
		"http://fwd--0123456789abcdef0123456789abcdef--web1.rdtun.localhost:8791",
	);
	assert.equal(forwardOrigin("https://tunnel.example", "web1"), undefined);
	assert.equal(forwardOrigin(ORIGIN, "Bad-ID"), undefined);
});

test(
	"ports tool defaults private, lists public endpoints, fences guests and closes on archive",
	{ timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Web app" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const ports = await holdIn(owner, Ports, {}, "owner");
		const store = (await fixture.server.host.registry(ForwardsNative, BACKGROUND_CONTEXT)).value!.forwards;
		store.radiusOrigin = ORIGIN;
		await ports.add({ port: 3000, name: "docs", public: true }, BACKGROUND_CONTEXT);
		// The answer follows its state: the new forward and its public link are on the page when the call resolves.
		const docs = ports.forwards.value.find((item) => item.port === 3000);
		assert.match(docs?.publicUrl ?? "", /^https:\/\/pub--/);
		await ports.setPublic({ id: docs!.id, public: false }, BACKGROUND_CONTEXT);
		assert.equal(ports.forwards.value.find((item) => item.port === 3000)?.publicUrl, undefined);
		await ports.setPublic({ id: docs!.id, public: true }, BACKGROUND_CONTEXT);
		await ports.add({ port: 3999 }, BACKGROUND_CONTEXT);
		const temporary = ports.forwards.value.find((item) => item.port === 3999)!;
		await ports.remove({ id: temporary.id }, BACKGROUND_CONTEXT);
		assert(!ports.forwards.value.some((item) => item.port === 3999), "the removed forward is gone at the answer");
		let serial = 0;
		const call = async (query: PortsRequest, target = chat) => {
			const count = results(await until(target.view, Boolean)).length;
			await target.send(
				{ text: `ports ${JSON.stringify(query)}`, requestId: `ports-${++serial}` },
				BACKGROUND_CONTEXT,
			);
			return results(
				await until(
					target.view,
					(view) => results(view).length > count && !(view?.docs["pi.live"] as { run?: unknown })?.run,
				),
			).at(-1)!;
		};
		const opened = await call({ action: "open", port: 5173, name: "web" });
		assert.equal(opened.isError, false);
		const web = store.list().find((item) => item.port === 5173)!;
		assert.equal(web.session, session.id);
		assert.equal(web.public, undefined);
		assert.match(text(opened), /Forwarded port 5173, private: https:\/\/fwd--/);
		assert.match(text(opened), /port 3000 \("docs"\), PUBLIC, added by the owner/);
		assert.match(text(opened), /Public endpoints, open to anyone/);
		assert.match(JSON.stringify(opened.details), /sessionTitle.*Web app/);
		assert.equal((await call({ action: "open", port: 5173, public: true })).isError, false);
		assert.equal(store.get(web.id)?.public, true);
		assert.equal(store.get(web.id)?.name, "web");
		// The owner's forward can be changed too; it keeps its address and stays the owner's.
		const shared = store.list().find((item) => item.port === 3000)!;
		assert.equal((await call({ action: "open", port: 3000, public: false })).isError, false);
		assert.deepEqual(store.get(shared.id), { id: shared.id, port: 3000, name: "docs" });
		await call({ action: "open", port: 3000, public: true });
		assert.equal(store.get(shared.id)?.public, true);
		assert.equal((await call({ action: "open", port: fixture.server.port })).isError, true);
		assert.equal(
			(await until(ports.forwards, (value) => Boolean(value?.find((item) => item.port === 5173))))?.find(
				(item) => item.port === 5173,
			)?.sessionTitle,
			"Web app",
		);
		await call({ action: "close", port: 5173 });
		assert.match(text(await call({ action: "close", port: 5173 })), /was not forwarded/);
		await call({ action: "open", port: 5174 });
		await fixture.server.reload(["ports"]);
		assert.equal((await call({ action: "list" })).isError, false);
		const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers,
			body: JSON.stringify({ token: links?.[0]?.token, name: "Owner" }),
		});
		const guest = fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
		const guestChat = await holdIn(guest, Chat, { session: session.id, conversation: 1 }, "participant");
		// No per-turn authority: a guest's turn uses the tool; the guest itself cannot hold the registry.
		assert.doesNotMatch(text(await call({ action: "list" }, guestChat)), /owner started/);
		await expectChord(whenLive(guest.hold(Ports, {}, BACKGROUND_CONTEXT)), "forbidden");
		// `query` is the worker's: the owner calling it anyway is refused.
		await expectChord(
			(ports as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query(
				{ conversation: 1, query: { action: "list" } },
				BACKGROUND_CONTEXT,
			),
			"invalid",
		);
		assert.equal(
			store.list().some((item) => item.port === 8080),
			false,
		);
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		assert.deepEqual(
			store.list().map((item) => item.port),
			[3000],
		);
		// The agent may close any forward, also the owner's.
		const other = await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT);
		const otherChat = await holdIn(owner, Chat, { session: other.id, conversation: 1 }, "participant");
		// A remote-environment session cannot open (Pi Mobile's message); it can still close.
		assert.equal((await call({ action: "list" }, otherChat)).isError, false);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Catalog, {})).update({ id: other.id, env: "gpu" }, ctx),
			BACKGROUND_CONTEXT,
		);
		const refused = await call({ action: "open", port: 9090 }, otherChat);
		assert.equal(refused.isError, true);
		assert.match(
			text(refused),
			/This session runs on "gpu": ports of remote environments cannot be forwarded yet, only ports of this device/,
		);
		const closedOwners = await call({ action: "close", port: 3000 }, otherChat);
		assert.equal(closedOwners.isError, false);
		assert.match(text(closedOwners), /Stopped forwarding port 3000/);
		assert.deepEqual(store.list(), []);
	},
);
