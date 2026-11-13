// Pi Mobile 78056b34e: subagents without their own cwd work in the session's, also when they were created before a
// move that left their copied cwd behind (a session moved from a phone to a remote env kept a phone path in its old
// subagents). The worker reconciles them at every start.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	type ConversationView,
	configure,
	createRegistry,
	Harness,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { openSessionStorage } from "../../src/runtime/session-store.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const text = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
const bash = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			message.role === "toolResult" && message.toolName === "bash"
				? message.content.flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
				: [],
		);

test(
	"a subagent left with a stale cwd by an earlier move works in the session's cwd again",
	{ timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture();
		let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
		t.after(async () => {
			await restarted?.close();
			await fixture.close();
		});
		const project = join(fixture.workspace, "project");
		const own = join(fixture.workspace, "own");
		mkdirSync(project);
		mkdirSync(own);
		const subagent = async (owner: Host, session: string, args: object, requestId: string) => {
			const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
			const status = await holdIn(owner, SessionStatus, {}, "reader");
			try {
				await chat.send({ text: `subagent ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);
				await until(chat.view, (view) => text(view).includes(`Echo: subagent ${JSON.stringify(args)}`), 30_000);
				await until(status.statuses, (value) => value?.[session]?.tasks === 0, 30_000);
			} finally {
				chat.release();
				status.release();
			}
		};

		let owner = fixture.browser();
		const session = (await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: project }, BACKGROUND_CONTEXT))
			.id;
		await subagent(owner, session, { action: "spawn", name: "old", message: "hi", tools: ["bash"] }, "old");
		await subagent(owner, session, { action: "spawn", name: "own", message: "hi", cwd: own, tools: ["bash"] }, "own");
		const listed = await until(
			(await holdIn(owner, Subagents, {}, "reader")).children,
			(value) => value?.[session]?.length === 2,
		);
		const children = new Map(listed?.[session]?.map((child) => [child.name, child.conversationId]));

		// What a session moved before subagents tracked their own cwd looks like: the child still holds a path of the machine
		// the session used to run on, which exists nowhere here.
		await fixture.server.close();
		const stored = await openSessionStorage(fixture.dataDir, session, context);
		const harness = await Harness.open(
			stored.storage,
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		try {
			await harness.commit(async (tx) => {
				await configure(tx, children.get("old") as ConversationId, { cwd: "/data/data/elsewhere/pi-private" });
			}, context);
		} finally {
			await harness.close(context);
			await stored.close();
		}

		restarted = await startServer({ dataDir: fixture.dataDir, port: fixture.server.port, fake: true, web: false });
		owner = fixture.browser();
		await subagent(owner, session, { action: "send", name: "old", message: "bash" }, "old-bash");
		await subagent(owner, session, { action: "send", name: "own", message: "bash" }, "own-bash");
		const pwd = async (name: string) => {
			const chat = await holdIn(owner, Chat, { session, conversation: children.get(name)! }, "participant");
			try {
				const view = await until(chat.view, (value) => bash(value).length > 0, 30_000);
				return { pwd: bash(view).join("\n"), cwd: (view?.docs["pi.agent"] as { cwd?: string }).cwd };
			} finally {
				chat.release();
			}
		};
		// The session's cwd, not the stale path, the server's process cwd or the app directory.
		assert.deepEqual(await pwd("old"), { pwd: project, cwd: project });
		assert.deepEqual(await pwd("own"), { pwd: own, cwd: own }, "a subagent spawned with its own cwd keeps it");
	},
);
