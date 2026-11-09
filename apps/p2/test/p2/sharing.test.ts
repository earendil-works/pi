// Sharing: links, joining as a guest, what guests may reach, per-author drafts, and live revocation.
// Guests use a loopback server with an allowed tunnel Host (share.test); no tunnel or real provider takes part.

import assert from "node:assert/strict";
import { join as joinPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow, type Held, isChordError, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { GuestPresence, Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { Access } from "../../src/runtime/access.ts";
import { expectVariant, type Host, type RefIn, type VariantOf } from "../../src/runtime/chord.ts";
import { senderText } from "../../src/runtime/sender.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { expectChord, type Fixture, holdIn, http, poll, startFixture, until, webBundle } from "./helpers.ts";

const TUNNEL = { Host: "share.test", Origin: "https://share.test" };
const live = (view: ConversationView | null | undefined): LiveState | undefined =>
	view?.docs["pi.live"] as unknown as LiveState | undefined;
const users = (view: ConversationView | null | undefined) =>
	view ? buildTranscript(wholeView(view)).items.flatMap((item) => (item.type === "user" ? [item] : [])) : [];

type Guest = { host: Host; socket: { readyState: number; close(): void }; cookie: string; id: string; name: string };

describe("sharing (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: Session;
	let other: Session;
	let sharing: Held<typeof Sharing>;

	const tunnel = (path: string, cookie = "", method = "GET", body?: string) =>
		http(fixture.server.port, path, {
			method,
			headers: { ...TUNNEL, ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" },
			...(body === undefined ? {} : { body }),
		});
	const linkOf = async (mode: "view" | "full", reset = false) => {
		await sharing.link({ mode, reset }, BACKGROUND_CONTEXT);
		// The answer follows its state: the (new) link is on the page when the call resolves.
		const link = sharing.links.value.find((entry) => entry.mode === mode);
		assert(link && (!reset || link.token !== tokens[mode]));
		tokens[mode] = link.token;
		return link;
	};
	const tokens: Record<string, string> = {};
	/** Joins through `token` with `name`; connects a client with the guest cookie. */
	const join = async (name: string, token: string): Promise<Guest> => {
		const response = await tunnel("/join", "", "POST", JSON.stringify({ token, name }));
		assert.equal(response.status, 200, response.body);
		const setCookie = String(response.headers["set-cookie"] ?? "");
		assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure/);
		const cookie = setCookie.split(";")[0] ?? "";
		const { host, socket } = fixture.client({ ...TUNNEL, Cookie: cookie });
		const access = await holdIn(host, Access, {}, "guest");
		const grant = await until(access.grant, Boolean);
		assert.equal(access.variant, "guest");
		assert.equal(grant?.session, session.id);
		// The web host holds GuestPresence for the page's lifetime.
		await whenLive(host.hold(GuestPresence, {}, BACKGROUND_CONTEXT));
		return { host, socket, cookie, id: grant?.id ?? "", name: grant?.name ?? "" };
	};
	const chatOf = <V extends VariantOf<typeof Chat>>(host: Host, variant: V, id = session.id) =>
		holdIn(host, Chat, { session: id, conversation: 1 }, variant);

	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"], web: true });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace, title: "Shared" }, BACKGROUND_CONTEXT);
		other = await sessions.create({ cwd: fixture.workspace, title: "Private" }, BACKGROUND_CONTEXT);
		sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await whenLive(sharing);
	});

	after(async () => {
		await fixture?.close();
	});

	let alice: Guest;
	let bob: Guest;

	it("creates one link per mode and serves its join page", async () => {
		assert.deepEqual(await until(sharing.links, (value) => value !== undefined), []);
		const view = await linkOf("view");
		assert.equal(view.url, `https://share.test/join/${view.token}`);
		assert.equal((await linkOf("view")).token, view.token, "copying again reuses the link");
		const joinPage = await tunnel(`/join/${view.token}`);
		assert.equal(joinPage.status, 200);
		assert.match(joinPage.body, /Shared/);
		assert.match(String(joinPage.headers["content-security-policy"]), /script-src 'nonce-/);
		// A cookieless loopback browser joins; the owner's browser, with its local owner session, goes straight to the
		// session.
		assert.equal((await http(fixture.server.port, `/join/${view.token}`)).status, 200);
		const ownerJoin = await fixture.http(`/join/${view.token}`);
		assert.equal(ownerJoin.status, 303);
		assert.equal(ownerJoin.headers.location, `/s/${session.id}`);
		assert.equal((await tunnel("/")).status, 401, "a tunnel request without a grant is not signed in");
		assert.equal((await tunnel(`/join/${"x".repeat(43)}`)).status, 410);
		const crossSite = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { Host: "share.test" },
			body: JSON.stringify({ token: view.token, name: "x" }),
		});
		assert.equal(crossSite.status, 403, "joining needs a same-origin request");
		assert.equal((await tunnel("/join", "", "POST", JSON.stringify({ token: view.token, name: " " }))).status, 400);
	});

	it("joins guests with their own identities", async () => {
		alice = await join("Alice", tokens.view ?? "");
		bob = await join("Alice", tokens.view ?? "");
		assert.notEqual(alice.id, bob.id);
		assert.equal(bob.name, "Alice (2)");
		const again = await tunnel("/join", alice.cookie, "POST", JSON.stringify({ token: tokens.view, name: "new" }));
		assert.equal(again.status, 200);
		assert.equal(again.headers["set-cookie"], undefined, "the same browser keeps its identity");
		const joined = await tunnel(`/join/${tokens.view}`, alice.cookie);
		assert.equal(joined.status, 303, "a joined guest goes straight to the session");
		const guests = await until(sharing.guests, (value) => value?.length === 2);
		assert.deepEqual(
			guests?.map((guest) => guest.mode),
			["view", "view"],
		);
	});

	it("limits read-only guests to reading their session", async () => {
		const host = alice.host;
		const list = await holdIn(host, Sessions, {}, "guest");
		const listed = await until(list.sessions, (value) => value !== undefined);
		assert.equal(list.variant, "guest");
		assert.deepEqual(
			listed?.map((item) => item.id),
			[session.id],
		);
		const status = await holdIn(host, SessionStatus, {}, "reader");
		const statuses = await until(status.statuses, (value) => value !== undefined);
		assert.deepEqual(
			Object.keys(statuses ?? {}).filter((id) => id !== session.id),
			[],
		);
		await assert.rejects(whenLive(host.hold(Models, {}, BACKGROUND_CONTEXT)), /forbidden|owner-only/);
		await assert.rejects(whenLive(host.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT)), /owner-only/);
		await assert.rejects(
			chatOf(host, "viewer", other.id),
			(error) => isChordError(error) && error.code === "forbidden",
		);
		const chat = await chatOf(host, "viewer");
		const page = await chat.entries({ limit: 10 }, BACKGROUND_CONTEXT);
		assert.ok(Array.isArray(page.items), "read-only guests page their session's entries");
		// @ts-expect-error `send` is a participant's: a viewer calling it anyway is refused.
		await expectChord(chat.send({ text: "x", requestId: "view" }, BACKGROUND_CONTEXT), "invalid");
		await assert.rejects(whenLive(host.hold(Drafts, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT)));
	});

	it("serves guests the app, never other sessions, sources or data", async () => {
		for (const path of ["/", `/s/${session.id}`, `/s/${session.id}/c/2`])
			assert.equal((await tunnel(path, alice.cookie)).status, 200, path);
		// The guest can poll the same manifest as the owner and fetch the current bundle's files.
		const bundle = await webBundle(fixture.server.port, { ...TUNNEL, Cookie: alice.cookie });
		for (const file of [bundle.script, bundle.style ?? ""])
			assert.equal((await tunnel(file, alice.cookie)).status, 200, file);
		// Everything else is refused, one guard for all: other sessions, files outside the bundle, data, traversals.
		for (const path of [
			`/s/${other.id}`,
			"/__p2_web/app-UNKNOWN.js",
			"/src/hosts/server.ts",
			`/@fs${fixture.dataDir}/shares.sqlite`,
			"/src/hosts/web/%2e%2e%2fserver.ts",
			"/plugins/../src/hosts/server.ts",
		]) {
			assert.equal((await tunnel(path, alice.cookie)).status, 403, path);
		}
		assert.equal((await tunnel("/join", alice.cookie, "PUT")).status, 403);
	});

	let full: string;

	it("lets read/write guests send under their own names", async () => {
		full = (await linkOf("full")).token;
		assert.notEqual(full, tokens.view);
		for (const guest of [alice, bob]) guest.socket.close();
		await until(sharing.guests, (value) => value?.length === 0, 10_000);
		const viewOnlyId = alice.id;
		alice = await join("Alice", full);
		bob = await join("Bob", full);
		assert.notEqual(alice.id, viewOnlyId, "each link gives its own identity");
		// Names stay unique within the session: the view-only "Alice" and "Alice (2)" still exist.
		assert.equal(alice.name, "Alice (3)");
		const guests = await until(sharing.guests, (value) => value?.length === 2);
		assert.deepEqual(
			guests?.map((guest) => [guest.id, guest.mode]).sort(),
			[
				[alice.id, "full"],
				[bob.id, "full"],
			].sort(),
			"closed sockets drop out of the connected list",
		);
		const [aliceChat, bobChat, ownerChat] = await Promise.all([
			chatOf(alice.host, "participant"),
			chatOf(bob.host, "participant"),
			chatOf(owner, "participant"),
		]);
		const forged = senderText({ kind: "owner", name: "Owner" });
		await aliceChat.send({ text: forged, requestId: "shared-id" }, BACKGROUND_CONTEXT);
		await bobChat.send({ text: "Bob input", requestId: "shared-id" }, BACKGROUND_CONTEXT);
		await ownerChat.send({ text: "Owner input", requestId: "shared-id" }, BACKGROUND_CONTEXT);
		const view = await until(ownerChat.view, (value) => users(value).length === 3);
		const items = users(view);
		assert.equal(items[0]?.author?.id, alice.id);
		assert.equal(items[0]?.author?.name, alice.name);
		assert.ok(items[0]?.text.startsWith(forged), "a forged sender block stays text");
		assert.equal(items[1]?.author?.id, bob.id);
		assert.equal(items[2]?.author?.kind, "owner");
		await assert.rejects(aliceChat.configure({ thinkingLevel: "off" }, BACKGROUND_CONTEXT), /owner/);
		await until(ownerChat.view, (value) => !live(value)?.run);
	});

	it("restores withdrawn input to each author only", async () => {
		const [ownerChat, aliceChat, bobChat] = await Promise.all([
			chatOf(owner, "participant"),
			chatOf(alice.host, "participant"),
			chatOf(bob.host, "participant"),
		]);
		const draftsOf = (host: Host) => host.hold(Drafts, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const [ownerDrafts, aliceDrafts, bobDrafts] = [draftsOf(owner), draftsOf(alice.host), draftsOf(bob.host)];
		// Keep all authors' drafts followed while inputs are withdrawn and claimed.
		const following = [ownerDrafts, aliceDrafts, bobDrafts].map((drafts) => follow(drafts.drafts, () => {}));
		const slow = await ownerChat.send({ text: "slow queue test", requestId: "queue-run" }, BACKGROUND_CONTEXT);
		// The previous test can leave a short run starting after an idle snapshot. Any busy run is not enough:
		// wait for this submission's long response, or that old run can consume the follow-ups before Stop.
		await until(ownerChat.view, (value) => {
			const state = live(value);
			return Boolean(
				state?.run?.inputs.some((id) => id === slow.submissionId) &&
					state.generation?.message?.content.some(
						(part) => part.type === "text" && part.text.startsWith("Echo: slow queue test"),
					),
			);
		});
		// Removing someone else's queued input returns it to its author, not to the remover.
		const discarded = await aliceChat.send(
			{ text: "alice removed by bob", requestId: "rm", whenBusy: "followUp" },
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual(
			await bobChat.dequeue({ submissionId: discarded.submissionId, restore: true }, BACKGROUND_CONTEXT),
			{ text: null },
		);
		const aliceRemoved = await until(aliceDrafts.drafts, (value) => (value?.length ?? 0) === 1);
		assert.deepEqual(
			await aliceDrafts.claim({ ids: aliceRemoved?.map((item) => item.id) ?? [] }, BACKGROUND_CONTEXT),
			{
				texts: ["alice removed by bob"],
			},
		);
		await ownerChat.send({ text: "owner queued", requestId: "oq" }, BACKGROUND_CONTEXT);
		await aliceChat.send({ text: "alice queued", requestId: "aq", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await bobChat.send({ text: "bob queued", requestId: "bq", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		assert.deepEqual(await ownerChat.stop(BACKGROUND_CONTEXT), { restored: ["owner queued"] });
		for (const [drafts, expected] of [
			[aliceDrafts, "alice queued"],
			[bobDrafts, "bob queued"],
		] as const) {
			const items = await until(drafts.drafts, (value) => (value?.length ?? 0) > 0);
			assert.deepEqual(
				items?.map((item) => item.text),
				[expected],
			);
			const ids = items?.map((item) => item.id) ?? [];
			assert.deepEqual(await drafts.claim({ ids }, BACKGROUND_CONTEXT), { texts: [expected] });
			assert.deepEqual(await drafts.claim({ ids }, BACKGROUND_CONTEXT), { texts: [] }, "claimed once");
		}
		assert.deepEqual(ownerDrafts.drafts.value, []);
		for (const unsubscribe of following) unsubscribe();
		await until(ownerChat.view, (value) => !live(value)?.run);
	});

	it("revokes removed guests and reset links at once", async () => {
		await chatOf(alice.host, "participant");
		await sharing.remove({ guestId: alice.id }, BACKGROUND_CONTEXT);
		await poll(() => alice.socket.readyState === 3, 10_000, "alice's socket closed");
		await until(sharing.guests, (value) => value?.length === 1);
		assert.equal((await tunnel("/", alice.cookie)).status, 401, "a removed guest has no grant");
		const rejoin = await tunnel("/join", alice.cookie, "POST", JSON.stringify({ token: full, name: "again" }));
		assert.equal(rejoin.status, 400, "a removed browser cannot mint a new identity with the same link");
		assert.match(rejoin.body, /removed/);
		const reset = await linkOf("full", true);
		assert.notEqual(reset.token, full);
		await poll(() => bob.socket.readyState === 3, 10_000, "bob's socket closed");
		await until(sharing.guests, (value) => value?.length === 0);
		const ended = await tunnel(`/join/${full}`);
		assert.equal(ended.status, 410);
		assert.match(ended.body, /This share has ended/);
		assert.equal((await tunnel(`/join/${tokens.view}`)).status, 200, "resetting one link leaves the other");
		assert.equal((await tunnel(`/join/${reset.token}`)).status, 200);
	});

	it("ends guest access while the session is archived, and restores it", async () => {
		const carol = await join("Carol", tokens.view ?? "");
		await chatOf(carol.host, "viewer");
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		await poll(() => carol.socket.readyState === 3, 10_000, "carol's socket closed");
		assert.equal((await tunnel(`/join/${tokens.view}`)).status, 410);
		assert.equal((await tunnel("/", carol.cookie)).status, 401);
		await sessions.restore({ id: session.id }, BACKGROUND_CONTEXT);
		assert.equal((await tunnel("/", carol.cookie)).status, 200, "restore gives the grant back");
		const { host } = fixture.client({ ...TUNNEL, Cookie: carol.cookie });
		await chatOf(host, "viewer");
	});

	it("gives a browser that joins another session's link both sessions", async () => {
		const otherSharing = owner.hold(Sharing, { session: other.id }, BACKGROUND_CONTEXT);
		await otherSharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const otherToken = (await until(otherSharing.links, (value) => (value?.length ?? 0) > 0))?.[0]?.token ?? "";
		const dave = await join("Dave", tokens.view ?? "");
		const again = await tunnel("/join", dave.cookie, "POST", JSON.stringify({ token: otherToken, name: "ignored" }));
		assert.equal(again.status, 200, again.body);
		assert.equal(again.headers["set-cookie"], undefined, "the browser keeps its identity");
		const { host } = fixture.client({ ...TUNNEL, Cookie: dave.cookie });
		const grant = await until((await holdIn(host, Access, {}, "guest")).grant, Boolean);
		assert.equal(grant?.id, dave.id);
		assert.deepEqual(grant?.sessions, { [session.id]: "view", [other.id]: "view" });
		assert.equal(grant?.session, other.id, "it lands in the session it joined last");
		for (const path of [`/s/${session.id}`, `/s/${other.id}`])
			assert.equal((await tunnel(path, dave.cookie)).status, 200, path);
		const listed = await until((await holdIn(host, Sessions, {}, "guest")).sessions, (value) => value?.length === 2);
		assert.deepEqual(listed?.map((item) => item.id).sort(), [session.id, other.id].sort());
	});
});

describe("sharing across restarts", () => {
	it("does not count a session archived before the restart as newly archived", async () => {
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		const { dataDir, workspace } = fixture;
		const revision = (): number => {
			const db = new DatabaseSync(joinPath(dataDir, "shares.sqlite"), { readOnly: true });
			try {
				return Number(db.prepare("SELECT revision FROM guests").get()?.revision);
			} finally {
				db.close();
			}
		};
		let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			const owner = fixture.browser();
			const sessions = await holdIn(owner, Sessions, {}, "owner");
			const session = await sessions.create({ cwd: workspace, title: "Archived" }, BACKGROUND_CONTEXT);
			const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
			const token = (await until(sharing.links, (value) => (value?.length ?? 0) > 0))?.[0]?.token ?? "";
			const port = fixture.server.port;
			const joined = await http(port, "/join", {
				method: "POST",
				headers: { ...TUNNEL, "Content-Type": "application/json" },
				body: JSON.stringify({ token, name: "Archived guest" }),
			});
			assert.equal(joined.status, 200, joined.body);
			await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
			await poll(() => revision() === 2, 10_000, "archiving bumped the grant");
			await owner.close(BACKGROUND_CONTEXT);
			await fixture.server.close();
			restarted = await startServer({ dataDir, port, fake: true, web: false, allowedHosts: ["share.test"] });
			// The archive listener's first value is the stored catalog, where the session is already archived: it bumps
			// nothing at startup. Only the restore bumps the grant.
			await restarted.host.root(
				async (ctx) => expectVariant(await ctx.get(Sessions, {}), "owner").restore({ id: session.id }, ctx),
				BACKGROUND_CONTEXT,
				{
					principal: { kind: "owner", access: "local" },
				},
			);
			await poll(() => revision() === 3, 10_000, "restoring bumped the grant once");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(revision(), 3);
		} finally {
			await restarted?.close();
			await fixture.close();
		}
	});

	it("keeps links and guest identities", async () => {
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		const { dataDir, workspace } = fixture;
		let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			const owner = fixture.browser();
			const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
				{ cwd: workspace, title: "Kept" },
				BACKGROUND_CONTEXT,
			);
			const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
			const token = (await until(sharing.links, (value) => (value?.length ?? 0) > 0))?.[0]?.token ?? "";
			const port = fixture.server.port;
			const joined = await http(port, "/join", {
				method: "POST",
				headers: { ...TUNNEL, "Content-Type": "application/json" },
				body: JSON.stringify({ token, name: "Persistent" }),
			});
			const cookie = String(joined.headers["set-cookie"] ?? "").split(";")[0] ?? "";
			await owner.close(BACKGROUND_CONTEXT);
			await fixture.server.close();
			restarted = await startServer({ dataDir, port, fake: true, web: false, allowedHosts: ["share.test"] });
			const guest = fixture.client({ ...TUNNEL, Cookie: cookie }).host;
			const chat = await holdIn(guest, Chat, { session: session.id, conversation: 1 }, "participant");
			await chat.send({ text: "survived restart", requestId: "r" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view).includes("Echo: survived restart"));
		} finally {
			await restarted?.close();
			await fixture.close();
		}
	});
});
