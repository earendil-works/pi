// Stopping a run from outside its chat (`RunControl`, the sidebar's Cancel): every input the stop withdraws waits as
// its author's draft, the stopper's own too; a viewer is refused; and the session's status says how the main
// conversation's last run ended (`SessionStatus.failure`, the sidebar's failed dot).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat, RunControl } from "../../plugins/chat/contract.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { type Fixture, holdWith, http, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const queued = (view: ConversationView | null | undefined) =>
	(view?.docs["pi.inbox"] as { items?: { id: number }[] } | undefined)?.items ?? [];

/** A guest of `session` admitted through a share link of `mode`. */
async function guestOf(fixture: Fixture, session: string, mode: "full" | "view") {
	const sharing = fixture.browser().hold(Sharing, { session }, BACKGROUND_CONTEXT);
	await sharing.link({ mode }, BACKGROUND_CONTEXT);
	const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === mode)));
	const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
	const joined = await http(fixture.server.port, "/join", {
		method: "POST",
		headers,
		body: JSON.stringify({ token: links?.find((link) => link.mode === mode)?.token, name: mode }),
	});
	return fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
}

test(
	"RunControl stops a run; withdrawn inputs wait as their authors' drafts; status says it was aborted",
	{
		timeout: 60_000,
	},
	async (t) => {
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const session = (
			await (
				await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER)
			).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const guest = await guestOf(fixture, session, "full");
		const viewer = await guestOf(fixture, session, "view");
		const ownerChat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
		const guestChat = await holdWith(guest, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
		const ownerDrafts = await holdWith(owner, Drafts, { session, conversation: 1 });
		const guestDrafts = await holdWith(guest, Drafts, { session, conversation: 1 });
		const status = await holdWith(owner, SessionStatus, {}, "statuses");
		t.after(follow(ownerChat.view, () => {}));

		await ownerChat.send({ text: "slow run", requestId: "run" }, BACKGROUND_CONTEXT);
		await until(ownerChat.view, (view) => Boolean(live(view)?.run));
		await ownerChat.send({ text: "owner next", requestId: "o", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await guestChat.send({ text: "guest next", requestId: "g", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await until(ownerChat.view, (view) => queued(view).length === 2);
		// While it runs, the session has no failure to show.
		assert.equal(
			(await until(status.statuses, (value) => Boolean(value?.[session]?.busy.length)))?.[session]?.failure,
			undefined,
		);

		// A viewer may not stop it; a read/write guest may, as the owner.
		const viewed = viewer.hold(RunControl, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		await assert.rejects(whenLive(viewed));
		const control = await holdWith(guest, RunControl, { session, conversation: 1 });
		await control.stop(BACKGROUND_CONTEXT);

		await until(ownerChat.view, (view) => !live(view)?.run && queued(view).length === 0);
		const mine = await until(ownerDrafts.drafts, (items) => Boolean(items?.length));
		const theirs = await until(guestDrafts.drafts, (items) => Boolean(items?.length));
		assert.deepEqual(
			[mine?.map((item) => item.text), theirs?.map((item) => item.text)],
			[["owner next"], ["guest next"]],
		);
		const ended = await until(status.statuses, (value) => value?.[session]?.failure !== undefined);
		assert.deepEqual([ended?.[session]?.busy, ended?.[session]?.failure?.reason], [[], "aborted"]);
	},
);
