// Cache warming (plugins/cache-warming): a conversation's last request is sent again with one output token before its
// prompt cache entry expires, while pi's policy says it pays off. The warmers run on mocked timers with fake models;
// a worker runs them end to end with the fake provider given a short cache lifetime.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type {
	CacheWarmingPhase,
	Context,
	Model,
	Models,
	ModelsSimpleStreamOptions,
	SimpleStreamOptions,
	StopReason,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, ConversationView, LiveState, UsageState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import type { ModelRequest } from "@p2/app/v1/worker";
import { type CacheWarmingMode, ConversationWarmers } from "../../plugins/cache-warming/warmer.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
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
const REQUEST = {
	model: MODEL,
	messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
	options: { sessionId: "provider-session", reasoning: "high" as const },
} satisfies ModelRequest;

/** Warmers on mocked timers; `phase` is what the host reports, `sent` the refreshes the fake models received. */
function setup(t: { after(fn: () => void): void }, mode: CacheWarmingMode = "idle") {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const state = {
		mode,
		phase: "streaming" as CacheWarmingPhase | undefined,
		alive: 0,
		sent: [] as ModelsSimpleStreamOptions[],
		recorded: 0,
	};
	const models = {
		completeSimple: async (_model: Model<"pi-messages">, context: Context, options: ModelsSimpleStreamOptions) => {
			assert.deepEqual(context.messages, REQUEST.messages);
			state.sent.push(options);
			return { ...fauxAssistantMessage([]), stopReason: options.signal?.aborted ? "aborted" : "length" };
		},
	} as unknown as Models;
	const warmers = new ConversationWarmers({
		mode: () => state.mode,
		phase: async () => state.phase,
		record: async () => {
			state.recorded++;
		},
		keepAlive: (delta) => {
			state.alive += delta;
		},
	});
	t.after(() => {
		warmers.close();
		mock.timers.reset();
	});
	/** Starts warming after a response to a `promptTokens`-token prompt. */
	const start = (
		promptTokens: number,
		stopReason: StopReason = "toolUse",
		options: SimpleStreamOptions = REQUEST.options,
	) => {
		const message = fauxAssistantMessage([]);
		const usage = { ...message.usage, input: 2, cacheRead: promptTokens - 1002, cacheWrite: 1000 };
		warmers.start(CONVERSATION, { ...message, stopReason, usage }, { ...REQUEST, options }, models);
	};
	/** Advances the clock by `ms` and lets the refreshes it fired finish (they arm the next timer when done). */
	const advance = async (ms: number) => {
		mock.timers.tick(ms);
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
	};
	/** Advances refresh by refresh until warming stops; returns how many refreshes were sent. */
	const runOut = async () => {
		for (let refresh = 0; refresh < 100 && state.alive > 0; refresh++) await advance(270_000);
		return state.sent.length;
	};
	return { state, warmers, start, advance, runOut };
}

test("refreshes every 270 s with the request's options and one output token, and counts the spend", async (t) => {
	const { state, start, advance } = setup(t);
	start(600_000);
	assert.equal(state.alive, 1);
	await advance(269_000);
	assert.equal(state.sent.length, 0);
	await advance(1_000);
	assert.equal(state.sent.length, 1);
	const [options] = state.sent;
	assert.equal(options!.sessionId, "provider-session");
	assert.equal(options!.reasoning, "high");
	assert.equal(options!.maxTokens, 1);
	assert.equal(options!.maxRetries, 0);
	assert.equal(options!.disableContinuation, true);
	assert.equal(state.recorded, 1);
	await advance(270_000);
	assert.equal(state.sent.length, 2);
});

test("warms up to an hour while streaming and 30 minutes while idle; mode streaming stops when idle", async (t) => {
	const streaming = setup(t);
	streaming.start(600_000);
	assert.equal(await streaming.runOut(), 13);
	mock.timers.reset();

	const idle = setup(t);
	idle.state.phase = "idle";
	idle.start(600_000);
	assert.equal(await idle.runOut(), 6);
	mock.timers.reset();

	const streamingOnly = setup(t, "streaming");
	streamingOnly.state.phase = "idle";
	streamingOnly.start(600_000);
	assert.equal(await streamingOnly.runOut(), 0);
});

test("does not warm what is not worth it or cannot be repeated", async (t) => {
	const { state, warmers, start, advance } = setup(t);
	// A failed or aborted response, a model without a cache lifetime for the retention: nothing starts.
	start(600_000, "error");
	start(600_000, "aborted");
	start(600_000, "toolUse", { cacheRetention: "none" });
	assert.equal(state.alive, 0);
	// Mode off (which also uninstalls the hook) stops a run at its next refresh.
	start(600_000);
	state.mode = "off";
	await advance(270_000);
	assert.equal(state.alive, 0);
	state.mode = "idle";

	// 10k tokens: a refresh costs more than it is expected to save.
	start(10_000);
	await advance(270_000);
	// 80k tokens: worth it while the run streams, not once only a 15% chance remains that it continues.
	start(80_000);
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	state.phase = "idle";
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);

	// The host says the conversation changed (reset, compaction, model) or ended (a settled subagent): it stops.
	state.phase = undefined;
	start(600_000);
	await advance(270_000);
	assert.equal(state.sent.length, 1);
	assert.equal(state.alive, 0);
	warmers.close();
});

test("the next response replaces the run; close stops it", async (t) => {
	const { state, warmers, start, advance } = setup(t);
	start(600_000);
	await advance(200_000);
	start(600_000);
	assert.equal(state.alive, 1);
	// The first run's timer is gone: the refresh comes 270 s after the second response.
	await advance(200_000);
	assert.equal(state.sent.length, 0);
	await advance(70_000);
	assert.equal(state.sent.length, 1);
	warmers.close();
	assert.equal(state.alive, 0);
	await advance(600_000);
	assert.equal(state.sent.length, 1);
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
		const tokens = (view: ConversationView | null | undefined) =>
			Object.values((view?.docs["pi.usage"] as unknown as UsageState | undefined)?.models ?? {}).reduce(
				(total, model) => total + model.totalTokens,
				0,
			);
		const answered = await until(chat.view, (view) => (view?.entries.length ?? 0) > 1 && !live(view)?.run, 30_000);
		const requests = () => readFileSync(requestLog, "utf8").split("\n").filter(Boolean);
		// Idle now: the refreshes repeat the request exactly, and their spend is the conversation's.
		await until(chat.view, (view) => tokens(view) > tokens(answered) && requests().length >= 3, 20_000);
		const [sent, ...refreshes] = requests();
		for (const refresh of refreshes) assert.equal(refresh, sent);
	},
);
