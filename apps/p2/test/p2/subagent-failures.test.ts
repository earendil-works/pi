// A subagent's run failure as the server's index lists it (`Subagents`' children, reported by
// plugins/subagents/worker.ts), end to end on the fake provider and a local provider that answers HTTP 400: a stopped
// run (`aborted`), a provider error (`model_error` and its text), a missing model (`no_model`, which ends the run in a
// commit without an entry), cleared by a later answer, and an idle subagent's failure kept while another one works.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { type Child, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { follow } from "../../src/runtime/refs.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const texts = (view: ConversationView | null | undefined): string[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		),
	);
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;

/** A models.json with the local provider (an OpenAI-compatible API at `port`) or without it. */
const modelsJson = (port: number | undefined) =>
	JSON.stringify({
		providers:
			port === undefined
				? {}
				: {
						local: {
							baseUrl: `http://127.0.0.1:${port}/v1`,
							apiKey: "fixture",
							api: "openai-completions",
							models: [{ id: "m1", contextWindow: 8000, maxTokens: 100 }],
						},
					},
	});

describe("subagent failures (fake provider)", () => {
	let provider: Server;
	let port: number;
	let fixture: Fixture;
	let owner: Host;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let children: RefIn<typeof Subagents, "reader">;
	const childOf = (value: Record<string, Child[]> | undefined, name: string) =>
		value?.[session]?.find((child) => child.name === name);
	/** Every failure `failing` showed, in order, from the moment it first failed. */
	const failingSeen: (Child["failure"] | "absent")[] = [];

	before(async () => {
		// The local provider refuses every request: HTTP 400, an error pi-ai does not retry.
		provider = createServer((_request, response) => {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fixture bad request", type: "invalid_request_error" } }));
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		port = (provider.address() as AddressInfo).port;
		fixture = await startFixture();
		// Before the session's worker starts, which reads it.
		await writeFile(join(fixture.dataDir, "models.json"), modelsJson(port));
		owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		children = await holdIn(owner, Subagents, {}, "reader");
		follow(children.children, (value) => {
			const failing = childOf(value, "failing");
			if (failing?.failure !== undefined || failingSeen.length > 0) failingSeen.push(failing?.failure ?? "absent");
		});
	});
	after(async () => {
		await fixture?.close();
		await new Promise((resolve) => provider?.close(resolve));
	});

	it("reports a provider error as model_error with its text", async () => {
		await chat.send({ text: "subagent", requestId: "helper" }, BACKGROUND_CONTEXT);
		await until(children.children, (value) => childOf(value, "helper") !== undefined);
		const spawn = { action: "spawn", name: "failing", model: "local/m1", message: "hello failing", tools: ["read"] };
		await chat.send({ text: `subagent ${JSON.stringify(spawn)}`, requestId: "failing" }, BACKGROUND_CONTEXT);
		const listed = await until(
			children.children,
			(value) => childOf(value, "failing")?.failure !== undefined,
			30_000,
		);
		const failure = childOf(listed, "failing")?.failure;
		assert.equal(failure?.reason, "model_error");
		assert.match(failure?.detail ?? "", /fixture bad request/);
		// The helper answered: no failure.
		assert.equal(childOf(listed, "helper")?.failure, undefined);
	});

	it("reports a stopped run as aborted (the stop keeps the streamed partial as an aborted entry)", async () => {
		const helper = childOf(children.children.value, "helper")!;
		const sub = await holdIn(owner, Chat, { session, conversation: helper.conversationId }, "participant");
		await sub.send({ text: "slow stopped", requestId: "slow" }, BACKGROUND_CONTEXT);
		// Stopped while the answer streams: its committed partial is kept.
		await until(sub.view, (view) => live(view)?.generation?.message !== undefined, 30_000);
		await sub.stop(BACKGROUND_CONTEXT);
		const listed = await until(children.children, (value) => childOf(value, "helper")?.failure !== undefined, 30_000);
		assert.deepEqual(childOf(listed, "helper")?.failure, { reason: "aborted" });
		const view = await until(sub.view, (value) => !live(value)?.run);
		const aborted = (view?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "aborted");
		assert.equal(aborted.length, 1, "this case writes an entry: the aborted partial");
		sub.release();
	});

	it("clears the failure after a later answer", async () => {
		const helper = childOf(children.children.value, "helper")!;
		const sub = await holdIn(owner, Chat, { session, conversation: helper.conversationId }, "participant");
		await sub.send({ text: "after the stop", requestId: "after" }, BACKGROUND_CONTEXT);
		await until(sub.view, (view) => texts(view).includes("Echo: after the stop"), 30_000);
		await until(children.children, (value) => childOf(value, "helper")?.failure === undefined, 30_000);
		sub.release();
	});

	it("keeps an idle subagent's failure while another subagent works (reported, never flapping)", () => {
		// Every report since `failing` failed: the helper's stop, answer and entries caused them.
		assert.ok(failingSeen.length >= 2, "reports while it was idle");
		for (const seen of failingSeen)
			assert.deepEqual(seen, { reason: "model_error", detail: (failingSeen[0] as { detail: string }).detail });
	});

	it("reports a missing model as no_model, though its run ends in a commit without an entry", async () => {
		const failing = childOf(children.children.value, "failing")!;
		const sub = await holdIn(owner, Chat, { session, conversation: failing.conversationId }, "participant");
		// The local provider leaves the configuration (hot-reloaded); a send until the worker's models follow.
		await writeFile(join(fixture.dataDir, "models.json"), modelsJson(undefined));
		for (let attempt = 1; ; attempt++) {
			await sub.send({ text: `missing ${attempt}`, requestId: `missing-${attempt}` }, BACKGROUND_CONTEXT);
			const ended = await until(sub.view, (value) => !live(value)?.run && live(value)?.runFailure !== undefined);
			if (live(ended)?.runFailure?.reason === "no_model") break;
			assert.ok(attempt < 20, "the worker's models follow models.json");
			await sleep(500);
		}
		const listed = await until(
			children.children,
			(value) => childOf(value, "failing")?.failure?.reason === "no_model",
			30_000,
		);
		assert.deepEqual(childOf(listed, "failing")?.failure, {
			reason: "no_model",
			detail: "Model local/m1 is not available",
		});
		// Durable's no_model end writes no entry: the newest entry is the user's message, the run ended after it.
		const view = await until(
			sub.view,
			(value) => !live(value)?.run && live(value)?.runFailure?.reason === "no_model",
		);
		assert.equal(view?.entries.at(-1)?.model?.[0]?.role, "user");
		sub.release();
	});
});
