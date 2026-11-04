// The location tools (plugins/locations): every main agent lists environments and directories and moves its session
// (after its turn); a subagent gets them only when its main agent chose them, and then moves only itself. The main agent
// places subagents with spawn/configure. Only turns the owner started may use them.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { AgentLocations } from "../../plugins/locations/contract.ts";
import { createLocationExtension } from "../../plugins/locations/tool.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { expectChord, holdIn, http, startFixture, until } from "./helpers.ts";

const results = (view: ConversationView | null | undefined, tool?: string): ToolResultMessage[] =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && (tool === undefined || message.toolName === tool),
		);
const text = (message: ToolResultMessage | undefined) =>
	message?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;

test("location tools: schemas and defaults", () => {
	const extension = createLocationExtension({
		server: {
			envs: async () => [],
			directories: async () => ({ path: "/", parent: null, directories: [], truncated: false }),
		},
		locate: async () => ({ env: null, cwd: "/" }),
	});
	assert.equal(extension.name, "p2-locations");
	assert.deepEqual(
		extension.tools?.map((tool) => tool.name),
		["location_envs", "location_dirs", "location_move"],
	);
	// Offered to the model by default (not deferred): every main agent has them.
	assert(extension.tools?.every((tool) => tool.deferred === undefined));
	const move = extension.tools?.find((tool) => tool.name === "location_move");
	assert.deepEqual(Object.keys((move?.parameters as { properties: object }).properties), ["location", "env", "cwd"]);
});

test(
	"main agents list and move; subagents are placed, and move only with the tool; guests are refused",
	{ timeout: 180_000 },
	async (t) => {
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const start = join(fixture.workspace, "start");
		const next = join(fixture.workspace, "next");
		const own = join(fixture.workspace, "own");
		const other = join(fixture.workspace, "other");
		for (const directory of [start, join(start, "alpha"), join(start, "beta"), next, own, other])
			mkdirSync(directory);
		const session = (await sessions.create({ cwd: start }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		let serial = 0;
		/** Sends `message` to `target` and returns the tool results it added, once the session is idle. */
		const call = async (message: string, target: RefIn<typeof Chat, "participant"> = chat, tool?: string) => {
			const before = results(await until(target.view, Boolean), tool).length;
			await target.send({ text: message, requestId: `locations-${++serial}` }, BACKGROUND_CONTEXT);
			const view = await until(target.view, (value) => results(value, tool).length > before && idle(value), 30_000);
			await until(status.statuses, (value) => value?.[session]?.tasks === 0, 30_000);
			return results(view, tool).slice(before);
		};
		const child = async (name: string) =>
			(await until(agents.children, (value) => Boolean(value?.[session]?.some((each) => each.name === name))))?.[
				session
			]?.find((each) => each.name === name);

		// The main agent lists environments and folders.
		const [envs] = await call("location_envs {}");
		assert.equal(envs?.isError, false);
		assert.match(text(envs), new RegExp(`You work at ${start}`));
		assert.match(text(envs), /- local: this device \(where p2 runs\) · you are here/);
		const [dirs] = await call(`location_dirs ${JSON.stringify({ location: "." })}`);
		assert.equal(dirs?.isError, false, text(dirs));
		assert.match(text(dirs), /^.*start.*\nalpha\/\nbeta\/$/);
		const [missing] = await call(`location_dirs ${JSON.stringify({ location: "nowhere:/x" })}`);
		assert.equal(missing?.isError, true);
		assert.match(text(missing), /Unknown environment "nowhere"/);

		// It places subagents: its own location (env and cwd) and tools; without them a subagent follows the session.
		await call(
			`subagent ${JSON.stringify({ action: "spawn", name: "placed", message: "hi", env: null, cwd: "../own", tools: ["bash", "location_move"] })}`,
		);
		const placed = await child("placed");
		assert.deepEqual(placed?.location, { env: null, cwd: own });
		assert.deepEqual(placed?.tools, ["bash", "location_move"]);
		await call(`subagent ${JSON.stringify({ action: "spawn", name: "plain", message: "hi", tools: ["bash"] })}`);
		assert.equal((await child("plain"))?.location, undefined);
		// Reconfigured while idle: another directory, then following the session again, then back.
		await call(`subagent ${JSON.stringify({ action: "configure", name: "placed", cwd: other })}`);
		await until(
			agents.children,
			(value) => value?.[session]?.find((each) => each.name === "placed")?.location?.cwd === other,
		);
		await call(`subagent ${JSON.stringify({ action: "configure", name: "placed", followSession: true })}`);
		await until(
			agents.children,
			(value) => value?.[session]?.find((each) => each.name === "placed")?.location === undefined,
		);
		const [bad] = await call(`subagent ${JSON.stringify({ action: "configure", name: "placed", cwd: "nowhere" })}`);
		assert.match(text(bad), /cwd nowhere is not an existing directory/);
		await call(`subagent ${JSON.stringify({ action: "configure", name: "placed", cwd: own })}`);
		await until(
			agents.children,
			(value) => value?.[session]?.find((each) => each.name === "placed")?.location?.cwd === own,
		);

		// A subagent without the location tools cannot move; one given location_move moves only itself, at once.
		const plain = await holdIn(
			owner,
			Chat,
			{ session, conversation: (await child("plain"))!.conversationId },
			"participant",
		);
		const sendTo = (name: string, message: string) =>
			call(`subagent ${JSON.stringify({ action: "send", name, message })}`);
		await sendTo("plain", `location_move ${JSON.stringify({ location: other })}`);
		const refused = results(
			await until(plain.view, (value) => results(value).some((each) => each.toolName === "location_move")),
		).find((each) => each.toolName === "location_move");
		assert.equal(refused?.isError, true);
		assert.equal((await child("plain"))?.location, undefined);
		// A working subagent's location does not change under it.
		await plain.send({ text: "slow work", requestId: "slow-plain" }, BACKGROUND_CONTEXT);
		await until(plain.view, (view) => !idle(view));
		const [busy] = await call(`subagent ${JSON.stringify({ action: "configure", name: "plain", cwd: other })}`);
		assert.match(text(busy), /plain is working: stop it or wait before changing its location/);
		await plain.stop(BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session]?.tasks === 0);
		assert.equal((await child("plain"))?.location, undefined);
		const mover = await holdIn(owner, Chat, { session, conversation: placed!.conversationId }, "participant");
		await sendTo("placed", `location_move ${JSON.stringify({ location: other })}`);
		const moved = await until(mover.view, (value) => results(value, "location_move").length > 0);
		assert.equal(results(moved, "location_move")[0]?.isError, false, text(results(moved, "location_move")[0]));
		await until(
			agents.children,
			(value) => value?.[session]?.find((each) => each.name === "placed")?.location?.cwd === other,
		);
		assert.equal((await child("plain"))?.location, undefined, "the other subagent stays put");

		// The main agent moves its session once its turn has ended; the follower follows, the placed one stays.
		const [scheduled] = await call(`location_move ${JSON.stringify({ location: next })}`);
		assert.equal(scheduled?.isError, false, text(scheduled));
		assert.match(text(scheduled), /moves to .*next when this turn ends/);
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === session)?.cwd === next, 30_000);
		await until(chat.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === next);
		await until(plain.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === next);
		assert.equal((await child("placed"))?.location?.cwd, other);
		const [after] = await call("location_envs {}");
		assert.match(text(after), new RegExp(`You work at ${next}`));

		// Guests can neither discover environments nor move agents.
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
		const guestChat = await holdIn(guest, Chat, { session, conversation: 1 }, "participant");
		const [denied] = await call("location_envs {}", guestChat);
		assert.equal(denied?.isError, true);
		assert.match(text(denied), /needs a turn the owner started/);
		const [noMove] = await call(`location_move ${JSON.stringify({ location: start })}`, guestChat);
		assert.equal(noMove?.isError, true);
		// Nor through a subagent, nor by placing one on another environment.
		const moves = results(mover.view.value, "location_move").length;
		await call(
			`subagent ${JSON.stringify({ action: "send", name: "placed", message: `location_move ${JSON.stringify({ location: own })}` })}`,
			guestChat,
		);
		const guestMove = await until(mover.view, (value) => results(value, "location_move").length > moves);
		assert.equal(results(guestMove, "location_move").at(-1)?.isError, true);
		assert.equal((await child("placed"))?.location?.cwd, other);
		const [elsewhere] = await call(
			`subagent ${JSON.stringify({ action: "spawn", name: "far", message: "hi", env: "box", cwd: "/" })}`,
			guestChat,
		);
		assert.match(text(elsewhere), /Another environment needs a turn the owner started/);
		await expectChord(whenLive(guest.hold(AgentLocations, {}, BACKGROUND_CONTEXT)), "forbidden");
		await expectChord(whenLive(owner.hold(AgentLocations, {}, BACKGROUND_CONTEXT)), "forbidden");
		assert.equal((await until(sessions.sessions, Boolean))?.find((row) => row.id === session)?.cwd, next);
		for (const ref of [chat, plain, mover, guestChat]) ref.release();
	},
);
