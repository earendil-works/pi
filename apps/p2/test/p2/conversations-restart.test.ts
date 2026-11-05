// A peer message reaches a session whose worker went away (killed, idle-stopped, paused for a relocation): the
// server re-holds the worker like a browser opening it, and the recipient's turn runs.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { ConversationBroker, type Query } from "../../plugins/conversations/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { PEER_MESSAGE_ENTRY } from "../../src/runtime/entries.ts";
import { Hosts, ServerNatives } from "../../src/runtime/server.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const delivered = (view: ConversationView | null | undefined, message: string): boolean =>
	(view?.entries ?? []).some(
		(entry) => entry.kind === PEER_MESSAGE_ENTRY && JSON.stringify(entry.model?.[0]?.content).includes(message),
	);
const answered = (view: ConversationView | null | undefined, message: string): boolean =>
	JSON.stringify(view?.entries ?? []).includes(`Echo: ${message}`) &&
	!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run;

describe("conversations to a restarted worker (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let status: RefIn<typeof SessionStatus, "reader">;
	let alpha: string;
	let beta: string;
	let serial = 0;
	before(async () => {
		fixture = await startFixture({ idleMs: 400 });
		owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		alpha = (await sessions.create({ cwd: fixture.workspace, title: "Alpha" }, BACKGROUND_CONTEXT)).id;
		beta = (await sessions.create({ cwd: fixture.workspace, title: "Beta" }, BACKGROUND_CONTEXT)).id;
		status = await holdIn(owner, SessionStatus, {}, "reader");
	});
	after(async () => {
		await fixture?.close();
	});
	const broker = (query: Query) =>
		fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(ConversationBroker, {})).query(
					{ source: alpha, requestId: `restart-${++serial}`, query },
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
	/** Sends from alpha to beta (server-side, as alpha's tool does) and waits for beta's turn on that message. */
	const sendAndRun = async (message: string): Promise<void> => {
		const result = await broker({ action: "send", to: beta, message });
		assert.equal(result.action, "send");
		const chat = await holdIn(owner, Chat, { session: beta, conversation: 1 }, "participant");
		try {
			await until(chat.view, (view) => delivered(view, message) && answered(view, message));
		} finally {
			chat.release();
		}
	};
	const pid = async (): Promise<number> => {
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		try {
			return (await until(hosts.workers, (value) => Boolean(value?.[beta]?.running && value[beta]?.pid)))![beta]!
				.pid!;
		} finally {
			hosts.release();
		}
	};
	// A released Chat lingers 30 s on the worker, which keeps it alive (Chord's activity counts lingering objects).
	const stopped = () => until(status.statuses, (value) => value?.[beta]?.running === false, 45_000);

	it("delivers before and after beta's worker is SIGKILLed", async () => {
		await sendAndRun("first");
		for (let round = 0; round < 3; round++) {
			process.kill(await pid(), "SIGKILL");
			// Immediately, while the server may still see the dying worker as running.
			await sendAndRun(`after kill ${round}`);
		}
		process.kill(await pid(), "SIGKILL");
		await stopped();
		await sendAndRun("after kill settled");
	});

	it("delivers after beta's worker stopped idle", async () => {
		await sendAndRun("before idle");
		await stopped();
		await sendAndRun("after idle");
	});

	it("delivers after beta's worker was paused (relocation)", async () => {
		// An open view keeps the worker running, so the pause stops and restarts it.
		const viewer = await holdIn(owner, Chat, { session: beta, conversation: 1 }, "participant");
		try {
			await until(viewer.view, Boolean);
			const before = await pid();
			const manager = await fixture.server.host.root(
				async (ctx) => (await fixture.server.host.registry(ServerNatives, ctx)).value?.workers,
				BACKGROUND_CONTEXT,
			);
			assert.ok(manager);
			await manager.pause(
				beta,
				async () => undefined,
				async () => {},
				"testing",
			);
			assert.notEqual(await pid(), before, "the pause restarted the worker");
			await sendAndRun("after pause");
		} finally {
			viewer.release();
		}
	});
});
