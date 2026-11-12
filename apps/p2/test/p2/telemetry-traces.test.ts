// The owner's telemetry read back (plugins/telemetry): `Traces` serves the owner and the worker of a session neither
// shared nor locked (checked at each call: sharing later cuts its agent off), refuses anyone else, bounds and pages its
// results; the agent's `telemetry` code-mode tools find traces, render one and find metrics, and are refused in a
// shared session and absent in a locked one; the Traces view's pane searches, opens a trace (one at a time on a phone)
// and its spans' details, and Settings shows it too. Fake provider, disposable data.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, isChordError } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { SessionLock, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Traces } from "../../plugins/telemetry/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import type { GuestPrincipal } from "../../src/runtime/principals.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const GUEST: GuestPrincipal = {
	kind: "guest",
	id: "g-1",
	name: "Ada",
	home: "s",
	sessions: {},
	revision: 1,
};

const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
const output = (message: ToolResultMessage | undefined): string =>
	text(message).replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/, "");

/** The code-mode result after the input `said`. */
const scriptAfter = (view: ConversationView | null | undefined, said: string): ToolResultMessage | undefined => {
	const entries = view?.entries ?? [];
	const asked = entries.findLastIndex((entry) => (entry.data as { text?: string } | undefined)?.text === said);
	if (asked < 0) return undefined;
	return entries
		.slice(asked + 1)
		.flatMap((entry) => entry.model ?? [])
		.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		);
};

describe("the owner's telemetry read back", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let sent = 0;

	/** A new session of the owner. */
	const session = async (title: string) =>
		(await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
	/** Has the agent of `id` run `code` in code mode; its result. */
	const script = async (id: string, code: string): Promise<ToolResultMessage> => {
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const said = `codemode ${code}\n// ${++sent}`;
		await chat.send({ text: said, requestId: `script-${sent}` }, BACKGROUND_CONTEXT);
		let result: ToolResultMessage | undefined;
		await until(chat.view, (value) => {
			result = scriptAfter(value, said);
			return result !== undefined && idle(value);
		});
		chat.release();
		return result!;
	};
	/** The worker of session `id`, as the server sees its link. */
	const worker = (id: string) => fixture.as({ kind: "worker", session: id, generation: 1 });

	before(async () => {
		fixture = await startFixture({ web: browserTests });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		// Traces to read: a session's turn (the worker's, Durable's and pi-ai's spans), written within a second.
		const first = await session("First");
		await script(first, "return 1;");
		const traces = await holdIn(owner, Traces, {}, "owner");
		await poll(
			async () => (await traces.findTraces({ name: "pi.durable.submit" }, BACKGROUND_CONTEXT)).traces.length > 0,
		);
		traces.release();
	});
	after(() => fixture?.close());

	it("serves the owner bounded, paged searches, a trace's spans, and metrics", async () => {
		const traces = await holdIn(owner, Traces, {}, "owner");
		const page = await traces.findTraces({ limit: 1 }, BACKGROUND_CONTEXT);
		assert.equal(page.traces.length, 1);
		assert.ok(page.cursor, "more than one trace: a cursor");
		const next = await traces.findTraces({ limit: 1, cursor: page.cursor! }, BACKGROUND_CONTEXT);
		assert.notEqual(next.traces[0]?.traceId, page.traces[0]?.traceId);
		const [submit] = (await traces.findTraces({ name: "pi.durable.submit", limit: 1 }, BACKGROUND_CONTEXT)).traces;
		assert.ok(submit && submit.spans > 0 && submit.hosts.some((host) => host.startsWith("session|")));
		const trace = await traces.getTrace({ traceId: submit.traceId }, BACKGROUND_CONTEXT);
		assert.equal(trace?.spans.length, submit.spans);
		assert.equal(trace?.truncated, false);
		assert.deepEqual(
			trace?.spans.map((span) => span.startedMs),
			[...(trace?.spans ?? [])].map((span) => span.startedMs).sort((a, b) => a - b),
		);
		assert.equal(await traces.getTrace({ traceId: "nope" }, BACKGROUND_CONTEXT), null);
		const filters = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
		const refused = await traces.findTraces({ attributes: filters }, BACKGROUND_CONTEXT).catch((error) => error);
		assert.ok(isChordError(refused, "invalid"), String(refused));
		const metrics = await traces.findMetrics({ name: "chord.link.bytes" }, BACKGROUND_CONTEXT);
		assert.equal(metrics.truncated, false);
		traces.release();
	});

	it("refuses guests, and a worker while its session is shared or locked, at every call", async () => {
		const guest = await fixture
			.as(GUEST)
			.get(Traces, {}, BACKGROUND_CONTEXT)
			.catch((error) => error);
		assert.ok(isChordError(guest, "forbidden"), String(guest));
		// A plain session's worker reads; once the session is shared (a view link), the same object refuses.
		const plain = await session("Plain");
		const agent = await holdIn(worker(plain), Traces, {}, "agent");
		assert.ok((await agent.findTraces({ limit: 1 }, BACKGROUND_CONTEXT)).traces.length === 1);
		const sharing = await holdIn(owner, Sharing, { session: plain }, "owner");
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		await poll(async () => {
			const error = await agent.findTraces({ limit: 1 }, BACKGROUND_CONTEXT).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			return isChordError(error, "forbidden") && /shared/.test(String(error));
		});
		// A locked session's worker is refused too.
		const locked = await session("Locked");
		const locks = await holdIn(owner, SessionLock, {}, "owner");
		await locks.set(
			{ session: locked, lock: { mcp: [], projectMcp: false, instructions: false, capabilities: [] } },
			BACKGROUND_CONTEXT,
		);
		const lockedAgent = await holdIn(worker(locked), Traces, {}, "agent");
		const error = await lockedAgent.findTraces({}, BACKGROUND_CONTEXT).catch((failure: unknown) => failure);
		assert.ok(isChordError(error, "forbidden") && /locked/.test(String(error)), String(error));
	});

	it("gives the agent its tools: traces found, one rendered with its spans, metrics; refused when shared", async () => {
		const id = await session("Tools");
		const result = await script(
			id,
			[
				'const found = await tools.telemetry_find_traces({ name: "pi.durable.submit", limit: 2 });',
				"const one = await tools.telemetry_get_trace({ traceId: found.traces[0].traceId });",
				"const none = await tools.telemetry_get_trace({ traceId: 'nope' });",
				'const metrics = await tools.telemetry_find_metrics({ name: "chord.link.bytes" });',
				"return { found: found.traces.length, spans: one.trace.spans.length, text: one.text.includes('pi.durable.submit'), none: none.found, metrics: Array.isArray(metrics.metrics) };",
			].join("\n"),
		);
		assert.equal(result.isError, false, text(result));
		const value = JSON.parse(output(result)) as Record<string, unknown>;
		assert.ok((value.found as number) >= 1 && (value.spans as number) >= 1, JSON.stringify(value));
		assert.deepEqual([value.text, value.none, value.metrics], [true, false, true]);
		await (await holdIn(owner, Sharing, { session: id }, "owner")).link({ mode: "full" }, BACKGROUND_CONTEXT);
		const shared = await script(id, "return await tools.telemetry_find_traces({ limit: 1 });");
		assert.match(text(shared), /this session is shared/);
	});

	describe("the Traces pane", { skip: !browserTests }, () => {
		let browser: Browser;
		let id: string;
		before(async () => {
			id = await session("Pane");
			const views = await holdIn(owner, Views, { session: id }, "editor");
			await views.open({ kind: "traces", title: "Traces" }, BACKGROUND_CONTEXT);
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
		});
		after(() => browser?.close());

		it("searches, opens a trace and a span's details one at a time on a phone, side by side when wide", async () => {
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
			await browser.wait("document.querySelector('.views-tabs.phone')");
			await browser.evaluate(
				`[...document.querySelectorAll('.views-tabs.phone .views-tab')].find(t=>t.textContent==='Traces').click()`,
			);
			// A search by the first span's name lists the turn's trace.
			await browser.wait("document.querySelector('.traces-row')");
			await browser.evaluate(
				`(() => { const input = document.querySelector('input[aria-label="Span name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'pi.durable.submit'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
			);
			await browser.click(".traces-form button[type=submit]");
			await browser.wait(
				"[...document.querySelectorAll('.traces-row-name')].length > 0 && [...document.querySelectorAll('.traces-row-name')].every((e) => e.textContent.includes('pi.durable.submit'))",
			);
			await browser.click(".traces-row");
			await browser.wait("document.querySelectorAll('.traces-tree .traces-span').length > 0");
			// One at a time: the list is hidden while the trace shows.
			assert.equal(
				await browser.evaluate<string>("getComputedStyle(document.querySelector('.traces-search')).display"),
				"none",
			);
			await browser.click(".traces-tree .traces-span");
			await browser.wait("document.querySelector('.traces-span-detail .traces-attributes')");
			await browser.click(".traces-back");
			await browser.wait("getComputedStyle(document.querySelector('.traces-search')).display !== 'none'");
			// Wide: the list beside the trace.
			await browser.metrics(1600, 900);
			await browser.click(".traces-row");
			await browser.wait(
				"document.querySelector('.traces-tree') && getComputedStyle(document.querySelector('.traces-search')).display !== 'none'",
			);
		});

		it("shows the same browser in Settings, a trace as a layer that Back closes", async () => {
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
			await browser.openSettings("Traces");
			await browser.wait("document.querySelector('.traces-sheet .traces-row')");
			await browser.click(".traces-sheet .traces-row");
			await browser.wait("document.querySelector('.traces-sheet .traces-tree .traces-span')");
			await browser.evaluate("history.back()");
			await browser.wait(
				"document.querySelector('.traces-sheet .traces-row') && !document.querySelector('.traces-sheet .traces-tree')",
			);
		});
	});
});
