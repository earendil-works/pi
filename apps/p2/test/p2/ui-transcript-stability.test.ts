// Browser: the transcript holds still. A long conversation (about 100 turns) is open at phone size (390×844); while a
// new turn arrives and its answer streams, the rows already shown do not render again and keep their DOM (React's
// commits and a MutationObserver, render-probe.ts), and a run going Working… → wheel → words → wheel → answer shifts
// nothing (Chromium's layout-shift entries). A reader scrolled up keeps what they look at. Fake provider, disposable
// data. With P2_SCREENSHOTS=<dir> it also saves screenshots of a mixed turn and of incoming messages.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryDraft, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions, SessionTransfer } from "../../plugins/sessions/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { bigSessionEntries } from "../fixtures/big-session.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";
import { type ProbeReport, RENDER_PROBE } from "./render-probe.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const answered = (text: string) => (view: ConversationView | null | undefined) =>
	JSON.stringify(view?.entries ?? []).includes(text) && !live(view)?.run;
const REPORT = "window.__probe.report()";
const RESET = "(window.__probe.reset(), true)";
/** Two frames: React committed and the browser laid out and painted. */
const FRAMES = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SCREENSHOTS = process.env.P2_SCREENSHOTS;

/**
 * The rows shown before a measurement that rendered again, changed their DOM, or were replaced; not those the virtual
 * list unmounted meanwhile (scrolled out of its range as the new rows pushed them up).
 */
function disturbed(report: ProbeReport, shown: readonly string[]) {
	const before = shown.filter((key) => !report.left.includes(key));
	return {
		rendered: before.filter((key) => report.renders[key]),
		churned: before.filter((key) => report.churn[key]),
		replaced: report.replaced.filter((key) => before.includes(key)),
	};
}

const author = { kind: "owner", id: "owner", name: "Owner" };
const input = (text: string, timestamp: number) =>
	({
		kind: "p2.input",
		data: { author, text, attachments: [] },
		model: [{ role: "user", content: [{ type: "text", text }], timestamp }],
	}) as EntryDraft;
const response = (content: Parameters<typeof fauxAssistantMessage>[0], timestamp: number, toolUse = false) =>
	({
		kind: "pi.assistant",
		model: [{ ...fauxAssistantMessage(content, toolUse ? { stopReason: "toolUse" } : {}), timestamp }],
	}) as EntryDraft;
const result = (id: string, name: string, text: string, timestamp: number) =>
	({
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content: [{ type: "text", text }],
				isError: false,
				timestamp,
			},
		],
	}) as EntryDraft;

/** A mixed turn (thinking, words, a run of calls, words, another call, thinking and the answer) and incoming messages. */
function mixedEntries(): EntryDraft[] {
	const at = 1_800_000_000_000;
	return [
		input("Check the build and tell me what broke.", at),
		response(
			[
				{ type: "thinking", thinking: "The build first, then the failing test." },
				{ type: "text", text: "Let me look at the build output first." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run build" } },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/app.ts" } },
			],
			at + 1,
			true,
		),
		result("c1", "bash", "Build failed: 1 error", at + 2),
		result("c2", "read", "export const app = 1;", at + 3),
		response(
			[
				{ type: "text", text: "The build fails in `app.ts`. Fixing the export." },
				{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/app.ts", oldText: "1", newText: "2" } },
			],
			at + 4,
			true,
		),
		result("c3", "edit", "Edited src/app.ts", at + 5),
		response(
			[
				{ type: "thinking", thinking: "The edit fixed it; summarize." },
				{
					type: "text",
					text: "Fixed: the export in `src/app.ts` had the wrong value.\n\n- The build passes again.\n- No other file changed.\n\n```ts\nexport const app = 2;\n```",
				},
			],
			at + 6,
		),
		{
			kind: "p2.agent-message",
			data: { from: { name: "helper", conversationId: 2 }, intent: "answered", text: "Done: **all** tests pass." },
			model: [{ role: "user", content: [{ type: "text", text: "Done: all tests pass." }], timestamp: at + 7 }],
		} as EntryDraft,
		{
			kind: "p2.peer-message",
			data: { from: { id: "session-b", title: "Release notes" }, text: "Check *this* before the release." },
			model: [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: at + 8 }],
		} as EntryDraft,
		input("Thanks, that was quick.", at + 9),
		response([{ type: "text", text: "You're welcome." }], at + 10),
	];
}

describe("transcript stability", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	const url = (path: string) => `http://127.0.0.1:${fixture.server.port}${path}`;
	const seeded = async (title: string, entries: EntryDraft[]) => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace, title },
			BACKGROUND_CONTEXT,
		);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SessionTransfer, { session: session.id })).seed({ entries }, ctx),
			BACKGROUND_CONTEXT,
		);
		return session.id;
	};
	const screenshot = async (name: string) => {
		if (!SCREENSHOTS) return;
		const { data } = (await browser.call("Page.captureScreenshot", { format: "png" })) as { data: string };
		writeFileSync(join(SCREENSHOTS, `rerender-${name}.png`), Buffer.from(data, "base64"));
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "fixture.txt"), "fixture text\n");
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: RENDER_PROBE });
		await browser.metrics(390, 844);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("renders only the new and changed rows, and keeps the others' DOM, while turns arrive and stream", async () => {
		const session = await seeded("Long", bigSessionEntries(800, 400));
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.open(url(`/s/${session}`));
			await browser.wait(
				`document.querySelector('.composer textarea') && document.querySelectorAll('[data-row]').length > 3`,
			);
			await sleep(1_500);

			// A short turn: the person's message and its answer arrive.
			await browser.evaluate(RESET);
			const before = (await browser.evaluate<ProbeReport>(REPORT)).rows;
			await chat.send({ text: "hello", requestId: "hello" }, BACKGROUND_CONTEXT);
			await until(chat.view, answered("Echo: hello"), 30_000);
			await sleep(800);
			await browser.evaluate(FRAMES);
			const arrived = await browser.evaluate<ProbeReport>(REPORT);
			console.log(
				"turn arrived:",
				JSON.stringify({ ...disturbed(arrived, before), commits: arrived.commits, renders: arrived.renders }),
			);

			// A long answer streams: measured from its first words to its end.
			await chat.send({ text: "slow stream", requestId: "slow" }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.assistant .streaming')`);
			await browser.evaluate(RESET);
			const streaming = (await browser.evaluate<ProbeReport>(REPORT)).rows;
			await until(chat.view, answered("Echo: slow stream"), 60_000);
			await sleep(800);
			await browser.evaluate(FRAMES);
			const streamed = await browser.evaluate<ProbeReport>(REPORT);
			const liveRow = streaming.at(-1);
			const others = streaming.filter((key) => key !== liveRow);
			console.log(
				"stream:",
				JSON.stringify({
					...disturbed(streamed, others),
					commits: streamed.commits,
					live: liveRow,
					renders: streamed.renders,
				}),
			);

			assert.deepEqual(disturbed(arrived, before), { rendered: [], churned: [], replaced: [] }, "a new turn");
			assert.deepEqual(
				disturbed(streamed, others),
				{ rendered: [], churned: [], replaced: [] },
				"a streaming answer",
			);
		} finally {
			stop();
			chat.release();
		}
	});

	it("a run going Working… → wheel → words → wheel → answer shifts nothing", async () => {
		const session = await seeded("Steps", bigSessionEntries(40, 400));
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.open(url(`/s/${session}`));
			await browser.wait(
				`document.querySelector('.composer textarea') && document.querySelectorAll('[data-row]').length > 3`,
			);
			await sleep(1_500);
			// Thinking first (`steps`, then a plain echo), words first (`tool`): every first part takes the working
			// wheel's place without a jump; an inline artifact appears in place between two wheels without one either.
			for (const prompt of ["steps", "tool", "hello there", "inline-steps"]) {
				await browser.evaluate(RESET);
				await chat.send({ text: prompt, requestId: prompt }, BACKGROUND_CONTEXT);
				// The person's message is the anchor: following the bottom, it only ever moves up.
				const message = `[...document.querySelectorAll('.user .bubble')].findLast((bubble) => bubble.textContent.trim().endsWith(${JSON.stringify(prompt)}))?.closest('[data-row]')?.dataset.row`;
				await browser.wait(message);
				await browser.evaluate(`window.__probe.watch(${message})`);
				await until(chat.view, answered(`Echo: ${prompt}`), 60_000);
				await sleep(1_000);
				await browser.evaluate(FRAMES);
				const run = await browser.evaluate<ProbeReport>(REPORT);
				console.log(`run ${prompt}: shift`, run.shift.toFixed(4), JSON.stringify(run.shifts));
				console.log(`run ${prompt}: track`, JSON.stringify(run.track));
				if (prompt === "steps") await screenshot("run");
				assert.ok(run.shift < 0.01, `${prompt}: layout shift ${run.shift}: ${JSON.stringify(run.shifts)}`);
				assert.ok(run.track && run.track.frames > 10, `${prompt}: the run was followed`);
				assert.equal(Math.round(run.track.downs), 0, `${prompt}: jumped down ${JSON.stringify(run.track.moves)}`);
				assert.equal(run.track.shrinks, 0, `${prompt}: the transcript shrank while the run went on`);
				if (prompt === "inline-steps")
					// The turn's rows after the person's message: the artifact where it was made, between the two wheels.
					assert.deepEqual(
						await browser.evaluate<string[]>(
							`(() => { const rows=[...document.querySelectorAll('[data-row]')]; const at=rows.findIndex((row)=>row.dataset.row===${message}); return rows.slice(at+1).map((row)=>row.querySelector('[data-testid=activity]')?'activity':row.querySelector('.inline-artifact')?'inline':row.querySelector('.assistant')?'answer':row.dataset.row); })()`,
						),
						["activity", "inline", "activity", "answer"],
					);
			}

			// A reader scrolled up keeps what they look at while a turn arrives and streams below.
			await browser.evaluate("(document.querySelector('.scroller').scrollTop = 400, true)");
			await sleep(500);
			const watched = `(() => { const rows=[...document.querySelectorAll('[data-row]')]; const view=document.querySelector('.scroller').getBoundingClientRect(); const row=rows.find(r=>r.getBoundingClientRect().top>=view.top); return row && [row.dataset.row, Math.round(row.getBoundingClientRect().top)]; })()`;
			const [key, top] = await browser.evaluate<[string, number]>(watched);
			await chat.send({ text: "steps", requestId: "steps-2" }, BACKGROUND_CONTEXT);
			await until(
				chat.view,
				(view) => (JSON.stringify(view?.entries ?? []).match(/Echo: steps/g)?.length ?? 0) >= 2 && !live(view)?.run,
				60_000,
			);
			await sleep(1_000);
			const moved = await browser.evaluate<number | undefined>(
				`(() => { const row=document.querySelector('[data-row="${key}"]'); return row ? Math.round(row.getBoundingClientRect().top) : undefined; })()`,
			);
			assert.equal(moved, top, "the row the reader looked at stays put");
		} finally {
			stop();
			chat.release();
		}
	});

	it("shows a mixed turn and incoming messages (screenshots)", { skip: !SCREENSHOTS }, async () => {
		const session = await seeded("Mixed", mixedEntries());
		await browser.open(url(`/s/${session}`));
		await browser.wait(
			`document.querySelector('.composer textarea') && document.querySelectorAll('[data-row]').length > 5`,
		);
		await sleep(1_000);
		await browser.evaluate("(document.querySelector('.scroller').scrollTop = 0, true)");
		await sleep(600);
		await screenshot("mixed-top");
		await browser.evaluate(
			"(document.querySelector('.scroller').scrollTop = document.querySelector('.scroller').scrollHeight, true)",
		);
		await sleep(600);
		await screenshot("mixed-bottom");
	});
});
