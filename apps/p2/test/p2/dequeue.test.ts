// Removing someone else's queued input (×) discards it, as in Pi Mobile; moving it back to the editor (restore) still
// returns it to its author's composer (p2's draft rule), never to the person who moved it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { holdIn, http, settled, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const queued = (view: ConversationView | null | undefined) =>
	(view?.docs["pi.inbox"] as { items?: { id: number }[] } | undefined)?.items ?? [];

test("× discards another author's queued input; Move back returns it to its author", { timeout: 60_000 }, async (t) => {
	const fixture = await startFixture({ allowedHosts: ["share.test"] });
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const session = (
		await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
	).id;
	const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
	await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
	const links = await until(sharing.links, (value) => Boolean(value?.length));
	const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
	const joined = await http(fixture.server.port, "/join", {
		method: "POST",
		headers,
		body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
	});
	const guest = fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
	const ownerChat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	const guestChat = await holdIn(guest, Chat, { session, conversation: 1 }, "participant");
	const drafts = guest.hold(Drafts, { session, conversation: 1 }, BACKGROUND_CONTEXT);
	t.after(follow(ownerChat.view, () => {}));
	t.after(follow(drafts.drafts, () => {}));

	await ownerChat.send({ text: "slow run", requestId: "run" }, BACKGROUND_CONTEXT);
	await until(ownerChat.view, (view) => Boolean(live(view)?.run));
	const removed = await guestChat.send(
		{ text: "removed by owner", requestId: "rm", whenBusy: "followUp" },
		BACKGROUND_CONTEXT,
	);
	await until(ownerChat.view, (view) => queued(view).some((item) => item.id === removed.submissionId));
	assert.deepEqual(await ownerChat.dequeue({ submissionId: removed.submissionId }, BACKGROUND_CONTEXT), {
		text: null,
	});
	await until(ownerChat.view, (view) => !queued(view).some((item) => item.id === removed.submissionId));
	assert.deepEqual(await settled(drafts.drafts), [], "removed input goes to nobody");

	const moved = await guestChat.send(
		{ text: "moved by owner", requestId: "mv", whenBusy: "followUp" },
		BACKGROUND_CONTEXT,
	);
	await until(ownerChat.view, (view) => queued(view).some((item) => item.id === moved.submissionId));
	assert.deepEqual(await ownerChat.dequeue({ submissionId: moved.submissionId, restore: true }, BACKGROUND_CONTEXT), {
		text: null,
	});
	const restored = await until(drafts.drafts, (items) => Boolean(items?.length));
	assert.deepEqual(
		restored?.map((item) => item.text),
		["moved by owner"],
	);
	await ownerChat.stop(BACKGROUND_CONTEXT);
});
