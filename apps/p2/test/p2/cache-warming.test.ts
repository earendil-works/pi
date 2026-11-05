// Cache warming (plugins/cache-warming): the warmers re-send a conversation's last request before its prompt cache
// entry expires, with one output token, for as long as pi's policy says it pays off, and stop when the request no
// longer matches what the conversation sends next. Driven with a fake clock, timers and models, then end to end in a
// worker with the fake provider given a short cache lifetime.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	Models,
	ModelsSimpleStreamOptions,
	StopReason,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	ConversationView,
	GenerationRequest,
	LiveState,
	UsageState,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { type CacheWarmingMode, ConversationWarmers, extendsMessages } from "../../plugins/cache-warming/warmer.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { validateSettings } from "../../src/runtime/settings.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

const MODEL: Model<"pi-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://radius.example/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	promptCache: { short: 300, long: 3600 },
};
const CONVERSATION = 1 as ConversationId;
const SUBAGENT = 7 as ConversationId;
const MESSAGES: Message[] = [
	{ role: "user", content: "hello", timestamp: 1 },
	{ ...fauxAssistantMessage([]), timestamp: 2 },
	{ role: "user", content: "go on", timestamp: 3 },
];

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
	return {
		model: MODEL,
		messages: MESSAGES,
		options: { sessionId: "provider-session", reasoning: "high" },
		payloadReplaced: false,
		...overrides,
	};
}

/** A response whose prompt had `promptTokens` tokens, mostly read from the cache. */
function response(promptTokens: number, stopReason: StopReason = "toolUse"): AssistantMessage {
	const message = fauxAssistantMessage([]);
	return {
		...message,
		stopReason,
		usage: { ...message.usage, input: 2, cacheRead: promptTokens - 1002, cacheWrite: 1000 },
	};
}

/** A fake host: a manual clock and timers, models that record refreshes, and the conversation state as variables. */
function setup(mode: CacheWarmingMode = "idle") {
	const state = {
		mode,
		now: 0,
		running: new Set<ConversationId>([CONVERSATION, SUBAGENT]),
		current: true,
		alive: 0,
		timers: [] as { at: number; fn: () => void; cancelled: boolean }[],
		sent: [] as { model: Model<"pi-messages">; context: Context; options: ModelsSimpleStreamOptions }[],
		recorded: [] as ConversationId[],
		reports: [] as unknown[],
		/** Resolves the refresh in flight, when `hold` is set. */
		release: undefined as (() => void) | undefined,
		hold: false,
	};
	const models = {
		completeSimple: async (model: Model<"pi-messages">, context: Context, options: ModelsSimpleStreamOptions) => {
			state.sent.push({ model, context, options });
			if (state.hold)
				await new Promise<void>((resolve) => {
					state.release = resolve;
				});
			const reply = fauxAssistantMessage([]);
			return { ...reply, stopReason: options.signal?.aborted ? "aborted" : "length" };
		},
	} as unknown as Models;
	const warmers = new ConversationWarmers({
		mode: () => state.mode,
		now: () => state.now,
		setTimer: (fn, delayMs) => {
			const timer = { at: state.now + delayMs, fn, cancelled: false };
			state.timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		isCurrent: async () => state.current,
		running: async (conversationId) => state.running.has(conversationId),
		warmsIdle: async (conversationId) => conversationId === CONVERSATION,
		record: async (conversationId) => void state.recorded.push(conversationId),
		keepAlive: (delta) => {
			state.alive += delta;
		},
		report: (error) => void state.reports.push(error),
	});
	/** Moves the clock to the next armed timer and runs it; false when none is armed. */
	const tick = async (): Promise<boolean> => {
		const next = state.timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at)[0];
		if (next === undefined) return false;
		next.cancelled = true;
		state.now = next.at;
		next.fn();
		// The refresh awaits the host and the models a few times.
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		return true;
	};
	const start = (conversationId: ConversationId, promptTokens: number, sent = request(), stop?: StopReason) =>
		warmers.start(conversationId, { message: response(promptTokens, stop), request: sent }, models);
	return { state, warmers, tick, start };
}

test("refreshes before the 5-minute entry expires, with the request's own options and one output token", async () => {
	const { state, tick, start } = setup();
	start(CONVERSATION, 600_000);
	assert.equal(state.alive, 1);
	assert.ok(await tick());
	assert.equal(state.now, 270_000);
	assert.equal(state.sent.length, 1);
	const [refresh] = state.sent;
	assert.equal(refresh!.model, MODEL);
	assert.deepEqual(refresh!.context.messages, MESSAGES);
	assert.equal(refresh!.options.sessionId, "provider-session");
	assert.equal(refresh!.options.reasoning, "high");
	assert.equal(refresh!.options.maxTokens, 1);
	assert.equal(refresh!.options.maxRetries, 0);
	assert.equal(refresh!.options.disableContinuation, true);
	assert.deepEqual(state.recorded, [CONVERSATION]);
	// The next refresh is armed again one delay later.
	assert.ok(await tick());
	assert.equal(state.now, 540_000);
	assert.equal(state.sent.length, 2);
});

test("a 1-hour retention refreshes after 54 minutes", async () => {
	const { state, tick, start } = setup();
	start(CONVERSATION, 600_000, request({ options: { cacheRetention: "long" } }));
	assert.ok(await tick());
	assert.equal(state.now, 3_240_000);
	assert.equal(state.sent.length, 1);
});

test("streams up to an hour, idles up to 30 minutes, and stops after a settled subagent or in mode streaming", async () => {
	// While the run streams (a long tool call), refreshes go on until the hour after the request.
	const streaming = setup();
	streaming.start(CONVERSATION, 600_000);
	while (await streaming.tick());
	assert.equal(streaming.state.sent.length, 13);
	assert.ok(streaming.state.now <= 3_600_000);
	assert.equal(streaming.state.alive, 0);

	// After the run answered, the main conversation is warmed for 30 minutes.
	const idle = setup();
	idle.start(CONVERSATION, 600_000);
	idle.warmers.settled(CONVERSATION);
	idle.state.running.delete(CONVERSATION);
	while (await idle.tick());
	assert.equal(idle.state.sent.length, 6);
	assert.equal(idle.state.alive, 0);

	// A subagent is not warmed once its run settled, also when it ended without an answer (no `afterRun`).
	const subagent = setup();
	subagent.start(SUBAGENT, 600_000);
	subagent.state.running.delete(SUBAGENT);
	while (await subagent.tick());
	assert.equal(subagent.state.sent.length, 0);
	assert.equal(subagent.state.alive, 0);

	// Mode "streaming" stops when the run settles.
	const streamingOnly = setup("streaming");
	streamingOnly.start(CONVERSATION, 600_000);
	streamingOnly.warmers.settled(CONVERSATION);
	assert.equal(streamingOnly.state.alive, 0);
	assert.equal(await streamingOnly.tick(), false);
});

test("warms only what pays off: small prompts are not refreshed, idle needs larger ones than streaming", async () => {
	const small = setup();
	small.start(CONVERSATION, 10_000);
	await small.tick();
	assert.equal(small.state.sent.length, 0);
	assert.equal(small.state.alive, 0);

	// 80k tokens: worth a refresh while the run streams, not when only a 15% chance remains that it continues.
	const medium = setup();
	medium.start(CONVERSATION, 80_000);
	await medium.tick();
	assert.equal(medium.state.sent.length, 1);
	medium.warmers.settled(CONVERSATION);
	medium.state.running.delete(CONVERSATION);
	await medium.tick();
	assert.equal(medium.state.sent.length, 1);
	assert.equal(medium.state.alive, 0);
});

test("does not warm what it cannot repeat: failed responses, replaced bodies, changed contexts, mode off", async () => {
	for (const stop of ["error", "aborted"] as const) {
		const failed = setup();
		failed.start(CONVERSATION, 600_000, request(), stop);
		assert.equal(failed.state.alive, 0);
	}
	const replaced = setup();
	replaced.start(CONVERSATION, 600_000, request({ payloadReplaced: true }));
	assert.equal(replaced.state.alive, 0);

	const off = setup("off");
	off.start(CONVERSATION, 600_000);
	assert.equal(off.state.alive, 0);

	// A reset, compaction or model change before the refresh: nothing is sent, warming stops.
	const changed = setup();
	changed.start(CONVERSATION, 600_000);
	changed.state.current = false;
	await changed.tick();
	assert.equal(changed.state.sent.length, 0);
	assert.equal(changed.state.alive, 0);

	// Switched off while warming: the next refresh stops instead.
	const switched = setup();
	switched.start(CONVERSATION, 600_000);
	switched.state.mode = "off";
	await switched.tick();
	assert.equal(switched.state.sent.length, 0);
	assert.equal(switched.state.alive, 0);
});

test("a timer that fires too late stops instead of paying for a full cache write", async () => {
	const { state, tick, start } = setup();
	start(CONVERSATION, 600_000);
	// The process slept: the timer fires after the entry has (nearly) expired.
	state.timers[0]!.at = 299_000;
	await tick();
	assert.equal(state.sent.length, 0);
	assert.equal(state.alive, 0);
});

test("the next response replaces a conversation's run; close aborts a refresh in flight", async () => {
	const { state, warmers, tick, start } = setup();
	start(CONVERSATION, 600_000);
	start(CONVERSATION, 610_000);
	assert.equal(state.alive, 1);
	assert.equal(state.timers.filter((timer) => !timer.cancelled).length, 1);
	start(SUBAGENT, 600_000);
	assert.equal(state.alive, 2);

	state.hold = true;
	await tick();
	assert.equal(state.sent.length, 1);
	warmers.close();
	assert.equal(state.alive, 0);
	assert.equal(state.sent[0]!.options.signal?.aborted, true);
	state.release?.();
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
	// The aborted refresh records nothing and arms nothing.
	assert.deepEqual(state.recorded, []);
	assert.equal(await tick(), false);
	assert.deepEqual(state.reports, []);
});

test("a context extends the sent messages when it starts with them, by role and timestamp", () => {
	const next: Message = { role: "user", content: "more", timestamp: 4 };
	assert.equal(extendsMessages([...MESSAGES, next], MESSAGES), true);
	assert.equal(extendsMessages(MESSAGES, MESSAGES), true);
	// After a reset or compaction, the context starts with other messages.
	assert.equal(extendsMessages([{ role: "user", content: "summary", timestamp: 9 }, next], MESSAGES), false);
	assert.equal(extendsMessages(MESSAGES.slice(0, 2), MESSAGES), false);
});

test("settings.json accepts pi's cacheWarming modes", () => {
	assert.deepEqual(validateSettings({ cacheWarming: "streaming" }), { cacheWarming: "streaming" });
	assert.throws(() => validateSettings({ cacheWarming: "always" }), /Invalid settings/);
});

test(
	"a worker keeps the main conversation's cache warm after its run and counts the refreshes' spend",
	{ timeout: 90_000 },
	async (t) => {
		const scratch = mkdtempSync(join(tmpdir(), "p2-cache-warming-"));
		const requestLog = join(scratch, "requests.jsonl");
		writeFileSync(requestLog, "");
		const fixture = await startFixture({ workerEnv: { P2_FAKE_REQUESTS: requestLog } });
		t.after(async () => {
			await fixture.close();
			rmSync(scratch, { recursive: true, force: true });
		});
		// The fake model as a cached, expensive one, before the session's worker reads models.json: an 11-second
		// lifetime refreshes after one second, and every refresh pays off even for its small prompts.
		writeFileSync(
			join(fixture.dataDir, "models.json"),
			JSON.stringify({
				providers: {
					faux: {
						modelOverrides: {
							"faux-1": {
								cost: { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 5000 },
								promptCache: { short: 11 },
							},
						},
					},
				},
			}),
		);
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "m1" }, BACKGROUND_CONTEXT);
		const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
		const usage = (view: ConversationView | null | undefined) =>
			Object.values((view?.docs["pi.usage"] as unknown as UsageState | undefined)?.models ?? {}).reduce(
				(total, model) => total + model.totalTokens,
				0,
			);
		const answered = await until(chat.view, (view) => (view?.entries.length ?? 0) > 1 && !live(view)?.run, 30_000);
		const requests = () =>
			readFileSync(requestLog, "utf8")
				.split("\n")
				.filter((line) => line.length > 0);
		const [sent] = requests();
		assert.ok(sent);
		// Idle now: each refresh repeats the request exactly.
		const deadline = Date.now() + 20_000;
		while (requests().length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
		const refreshes = requests().slice(1);
		assert.ok(refreshes.length >= 2, `expected refreshes, got ${refreshes.length}`);
		for (const refresh of refreshes) assert.equal(refresh, sent);
		// Their spend counts as the conversation's.
		const before = usage(answered);
		await until(chat.view, (view) => usage(view) > before, 10_000);
	},
);
