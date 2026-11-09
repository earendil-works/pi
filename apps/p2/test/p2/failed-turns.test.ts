import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	type CompactionFailure,
	type ConversationView,
	createRegistry,
	type EntryId,
	Harness,
	type LiveState,
	type RunFailure,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { transcriptComponent } from "../../src/tui/messages.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

function viewOf(
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"] = [],
): ConversationView {
	const id = 1 as ConversationView["conversation"]["id"];
	const message: AssistantMessage = { ...fauxAssistantMessage([]), content, stopReason, timestamp: 1 };
	return {
		conversation: { id } as ConversationView["conversation"],
		docs: {},
		entries: [{ id: 1 as EntryId, conversationId: id, kind: "pi.assistant", model: [message] }],
	};
}

function runFailureView(reason: RunFailure["reason"], detail?: string): ConversationView {
	const runFailure: RunFailure = {
		taskId: 20 as RunFailure["taskId"],
		inputs: [],
		reason,
		...(detail === undefined ? {} : { detail }),
	};
	return { ...viewOf("stop"), entries: [], docs: { "pi.live": { runFailure } } };
}

function compactionView(
	trigger: CompactionFailure["trigger"] = "threshold",
	error = "Summarization failed: 400 prompt is too long",
): ConversationView {
	const base = viewOf("stop");
	const compactionFailure: CompactionFailure = { taskId: 10 as CompactionFailure["taskId"], trigger, error };
	return { ...base, entries: [], docs: { "pi.live": { compactionFailure } } };
}

test("compaction failures persist while idle, survive snapshots, replace older failures, and clear with the live record", () => {
	for (const trigger of ["manual", "threshold", "overflow"] as const) {
		const view = compactionView(trigger);
		const transcript = buildTranscript(wholeView(view));
		assert.deepEqual(transcript.items, [
			{
				type: "failure",
				key: "compaction-failure-10",
				text: "Compaction failed: Summarization failed: 400 prompt is too long",
			},
		]);
		assert.equal(transcript.busy, false);
		assert.equal(transcript.working, false);
		assert.equal(
			buildTranscript(wholeView({ ...view, docs: { ...view.docs, "pi.usage": {} } })).items[0],
			transcript.items[0],
		);
		const snapshot: ConversationView = JSON.parse(JSON.stringify(view));
		assert.deepEqual(buildTranscript(wholeView(snapshot)).items, transcript.items);
		const newer = compactionView("overflow", "new failure");
		assert.deepEqual(
			buildTranscript(wholeView(newer)).items.map((item) => item.type === "failure" && item.text),
			["Compaction failed: new failure"],
		);
		assert.deepEqual(buildTranscript(wholeView({ ...view, docs: { "pi.live": {} } })).items, []);
	}
});

test("a run that ended without an answer says why until the next run; Stop and a new context say nothing", () => {
	const texts = (view: ConversationView) =>
		buildTranscript(wholeView(view)).items.map((item) => (item.type === "failure" ? item.text : item.type));
	assert.deepEqual(texts(runFailureView("model_error", "400 prompt is too long")), [
		"The model could not answer this input. 400 prompt is too long",
	]);
	assert.deepEqual(texts(runFailureView("no_model", "Model faux/gone is not available")), [
		"The model could not answer this input. Model faux/gone is not available",
	]);
	assert.deepEqual(texts(runFailureView("faulted", "boom")), ["The run failed: boom"]);
	assert.deepEqual(texts(runFailureView("orphaned", "missing_task")), ["The run could not continue: missing_task"]);
	assert.deepEqual(texts(runFailureView("interrupted", "socket closed")), [
		"The answer was interrupted: the server stopped while the model was answering.",
	]);
	assert.deepEqual(
		texts(runFailureView("restart_limit", "The generation was interrupted 5 times in its request phase")),
		["The run was stopped after repeated restarts. The generation was interrupted 5 times in its request phase."],
	);
	assert.deepEqual(texts(runFailureView("aborted", "cut off")), []);
	assert.deepEqual(texts(runFailureView("reset")), []);
	// The same failure is the same item; a cleared one is gone.
	const view = runFailureView("model_error", "x");
	assert.equal(buildTranscript(wholeView(view)).items[0], buildTranscript(wholeView(view)).items[0]);
	assert.deepEqual(texts({ ...view, docs: { "pi.live": {} } }), []);
});

test("a blocking compaction failure that ended the run shows once; stored model-error notices of earlier versions stay", () => {
	const detail = "Compaction failed: Summarization failed: 400 prompt is too long";
	const compaction = compactionView();
	const live = compaction.docs["pi.live"] as LiveState;
	const runFailure: RunFailure = { taskId: 21 as RunFailure["taskId"], inputs: [], reason: "model_error", detail };
	const legacy = {
		id: 1 as EntryId,
		conversationId: compaction.conversation.id,
		kind: "app.model-error",
		data: { detail: "quota exceeded" },
	};
	const items = buildTranscript(
		wholeView({ ...compaction, entries: [legacy], docs: { "pi.live": { ...live, runFailure } } }),
	).items;
	assert.deepEqual(
		items.map((item) => (item.type === "failure" ? item.text : item.type)),
		["The model could not answer this input. quota exceeded", detail],
	);
	// Without the compaction failure the run's failure shows.
	const alone = buildTranscript(wholeView({ ...compaction, docs: { "pi.live": { runFailure } } })).items;
	assert.deepEqual(
		alone.map((item) => item.type === "failure" && item.text),
		[`The model could not answer this input. ${detail}`],
	);
});

test("empty abnormal assistant responses stay visible", () => {
	for (const reason of ["length", "error", "aborted", "deferred"] as const) {
		const item = buildTranscript(wholeView(viewOf(reason))).items[0];
		assert(item?.type === "assistant");
		assert.equal(item.message.stopReason, reason);
		assert.deepEqual(item.message.content, []);
	}
});

test("a model error shows from Durable's runFailure, live and after reopen, until the next run; no entry is written", async () => {
	const directory = await mkdtemp(join(tmpdir(), "failed-turn-storage-"));
	const context = BACKGROUND_CONTEXT;
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const options = { models, registry: createRegistry() };
	const path = join(directory, "session.sqlite");
	let storage = await openNodeSqliteStorage(path);
	let harness = await Harness.open(storage, options, context);
	try {
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 prompt is too long" }),
			fauxAssistantMessage([fauxText("fine")]),
		]);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		harness.resume();
		await (await root.submit({ type: "input", content: "answer me" }, context)).wait(context);
		const failures = async () => {
			const watch = await (await harness.root(context)).watch(context);
			const items = buildTranscript(wholeView(watch.value)).items;
			await watch.stop();
			return items.flatMap((item) => (item.type === "failure" ? [item.text] : []));
		};
		assert.deepEqual(await failures(), ["The model could not answer this input. 400 prompt is too long"]);
		await harness.close(context);
		storage = await openNodeSqliteStorage(path);
		harness = await Harness.open(storage, options, context);
		assert.deepEqual(await failures(), ["The model could not answer this input. 400 prompt is too long"]);
		const reopened = await harness.root(context);
		const kinds = (await reopened.entries({}, 100, undefined, context)).items.map((entry) => entry.kind);
		assert(!kinds.includes("app.model-error"), kinds.join());
		harness.resume();
		await (await reopened.submit({ type: "input", content: "again" }, context)).wait(context);
		assert.deepEqual(await failures(), []);
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"browser shows length, compaction, and model-error notices while idle",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("failed-turns.ts");
			await browser.wait("typeof window.showFailedTurn==='function'");
			const show = async (view: ConversationView) => {
				await browser?.evaluate(`window.showFailedTurn(${JSON.stringify(view)})`);
				await browser?.wait("document.querySelector('.messages')");
			};
			const empty = viewOf("length");
			await show(empty);
			await browser.wait(
				"document.querySelector('.notice')?.textContent.includes(\"The response hit the model's length limit\")",
			);
			await show(viewOf("length", [{ type: "text", text: "Partial answer" }]));
			await browser.wait("document.querySelector('.messages')?.textContent.includes('Partial answer')");
			assert.match(
				await browser.evaluate<string>("document.querySelector('.notice').textContent"),
				/The response hit the model's length limit/,
			);
			// A finished response with nothing in it shows nothing: no answer, no notice.
			await show(viewOf("stop"));
			await browser.wait("!document.querySelector('.assistant') && !document.querySelector('.notice')");
			const message = empty.entries[0]?.model?.[0];
			assert(message?.role === "assistant");
			await show({
				...empty,
				entries: [],
				docs: {
					"pi.live": {
						run: { taskId: 1, inputs: [] },
						generation: {
							attempt: 1,
							message: message as NonNullable<NonNullable<LiveState["generation"]>["message"]>,
						},
					},
				},
			});
			await browser.wait("document.querySelector('[data-testid=activity][data-state=working]')");
			assert.equal(await browser.evaluate("document.querySelector('.notice')!==null"), false);
			await show(viewOf("error"));
			await browser.wait(
				"document.querySelector('.notice')?.textContent.includes('The provider returned an error.')",
			);
			await show(viewOf("aborted"));
			await browser.wait("document.querySelector('.notice')?.textContent==='Stopped'");
			const failure = {
				...empty,
				entries: [
					{
						id: 3 as EntryId,
						conversationId: empty.conversation.id,
						kind: "app.model-error",
						data: { detail: "400 prompt is too long <script>unsafe</script>" },
					},
				],
			};
			await show(failure);
			await browser.wait(
				"document.querySelector('.notice.error')?.textContent.includes('The model could not answer this input. 400 prompt is too long')",
			);
			assert.equal(await browser.evaluate("document.querySelector('.messages script')!==null"), false);
			assert.equal(
				await browser.evaluate("document.querySelector('[data-testid=activity][data-state=working]')!==null"),
				false,
			);
			// Manual/background failures have no assistant or settlement entry, but must remain visible while idle.
			const compaction = compactionView("manual", "bad request <script>unsafe</script>");
			await show(compaction);
			await browser.wait(
				"document.querySelector('.notice.error')?.textContent==='Compaction failed: bad request <script>unsafe</script>'",
			);
			assert.equal(await browser.evaluate("document.querySelectorAll('.notice.error').length"), 1);
			assert.equal(await browser.evaluate("document.querySelector('.messages script')!==null"), false);
			assert.equal(
				await browser.evaluate("document.querySelector('[data-testid=activity][data-state=working]')!==null"),
				false,
			);
			assert.equal(
				await browser.evaluate("document.querySelector('.notice.error').getBoundingClientRect().height>0"),
				true,
			);
			await show({ ...compaction, docs: { ...compaction.docs, "pi.usage": {} } });
			await browser.wait(
				"document.querySelector('.notice.error')?.textContent==='Compaction failed: bad request <script>unsafe</script>'",
			);
			await show(runFailureView("interrupted", "socket closed"));
			await browser.wait(
				"document.querySelector('.notice.error')?.textContent==='The answer was interrupted: the server stopped while the model was answering.'",
			);
			assert.equal(await browser.evaluate("document.querySelectorAll('.notice.error').length"), 1);
			await show(runFailureView("aborted", "cut off"));
			await browser.wait("document.querySelector('.messages') && !document.querySelector('.notice.error')");
			const replacement = compactionView("overflow", "new failure");
			await show(replacement);
			await browser.wait("document.querySelector('.notice.error')?.textContent==='Compaction failed: new failure'");
			assert.equal(await browser.evaluate("document.querySelectorAll('.notice.error').length"), 1);
			await show({ ...replacement, docs: { "pi.live": {} } });
			await browser.wait("document.querySelector('.messages') && !document.querySelector('.notice.error')");
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);

test("p2 TUI shows the persistent compaction error once and removes it when Durable clears it", () => {
	const base = compactionView();
	const detail = "Compaction failed: Summarization failed: 400 prompt is too long";
	const live = base.docs["pi.live"] as LiveState;
	const runFailure: RunFailure = { taskId: 21 as RunFailure["taskId"], inputs: [], reason: "model_error", detail };
	const view = { ...base, docs: { "pi.live": { ...live, runFailure } } };
	const plain = transcriptComponent(buildTranscript(wholeView(view)), false, false)
		.render(200)
		.map(stripTerminalSequences)
		.join("\n");
	assert.equal(plain.split(detail).length - 1, 1);
	assert(!plain.includes("The model could not answer this input."));
	const cleared = transcriptComponent(buildTranscript(wholeView({ ...base, docs: { "pi.live": {} } })), false, false)
		.render(200)
		.map(stripTerminalSequences)
		.join("\n");
	assert(!cleared.includes("Compaction failed:"));
	const restarts = transcriptComponent(
		buildTranscript(wholeView(runFailureView("restart_limit", "The generation was interrupted 5 times"))),
		false,
		false,
	)
		.render(200)
		.map(stripTerminalSequences)
		.join("\n");
	assert(restarts.includes("The run was stopped after repeated restarts."));
});
