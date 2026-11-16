// Telemetry off (settings.json without `telemetry: true`, the default; on: telemetry.test.ts): the server opens no
// telemetry store, its ingest objects refuse everyone (a page loaded while telemetry was on is refused at once, never
// left waiting), workers record and send nothing, no page is marked to record, and the Traces object, its pane and the
// agent's tools say that telemetry is off. Fake provider, disposable data.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PageTelemetry, WorkerTelemetry } from "@earendil-works/chord/telemetry-ingest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { TELEMETRY_OFF, Traces } from "../../plugins/telemetry/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { telemetryStore } from "../../src/runtime/host-dirs.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

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

describe("telemetry off (the default)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: string;
	let sent = 0;

	/** Has the agent of `session` run `code` in code mode; its result, after the turn settled. */
	const script = async (code: string): Promise<ToolResultMessage> => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
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

	before(async () => {
		fixture = await startFixture({ web: browserTests });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Untraced" }, BACKGROUND_CONTEXT)).id;
	});
	after(() => fixture?.close());

	it("opens no store: a worker's turn leaves no telemetry.sqlite", async () => {
		const result = await script("return 1;");
		assert.equal(result.isError, false, text(result));
		assert.equal(existsSync(telemetryStore(fixture.dataDir)), false);
	});

	it("refuses a page still marked to record at once (forbidden, never unbound_long); a worker gets no ingest", async () => {
		const errors = mock.method(console, "error");
		try {
			// A page loaded while telemetry was on holds the page object as Chord's page does (`sendPageTelemetry`).
			const page = fixture.browser();
			const held = page.hold(PageTelemetry, {}, BACKGROUND_CONTEXT);
			const started = Date.now();
			await until(held.state, (state) => state.kind !== "loading", 2000);
			assert.ok(Date.now() - started < 2000);
			assert.deepEqual(
				[held.state.value.kind, (held.state.value as { cause?: { error?: { code?: string } } }).cause?.error?.code],
				["failed", "forbidden"],
			);
			const worker = fixture.as({ kind: "worker", session, generation: 1 });
			const ingest = await worker.get(WorkerTelemetry, {}, BACKGROUND_CONTEXT);
			assert.equal(ingest.variant, "other");
			// Past the 5 s after which a request nobody serves is reported.
			await sleep(5500);
			const unbound = errors.mock.calls.filter((call) =>
				call.arguments.some((value) =>
					typeof value === "string"
						? value.includes("has waited for")
						: (value as { kind?: string } | null)?.kind === "unbound_long",
				),
			);
			assert.deepEqual(unbound, []);
		} finally {
			errors.mock.restore();
		}
	});

	it("Traces and the agent's tools say telemetry is off", async () => {
		const traces = await holdIn(owner, Traces, {}, "owner");
		const refused = await traces.findTraces({}, BACKGROUND_CONTEXT).catch((error: unknown) => error);
		assert.deepEqual(
			[(refused as { code?: string }).code, (refused as Error).message],
			["unavailable", TELEMETRY_OFF],
		);
		traces.release();
		const result = await script("return await tools.telemetry_find_traces({ limit: 1 });");
		assert.match(text(result), /telemetry is off \(settings\.json telemetry\)/);
	});

	describe("pages", { skip: !browserTests }, () => {
		let browser: Browser;
		before(async () => {
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
		});
		after(() => browser?.close());

		it("marks no owner's page to record; the Traces pane says telemetry is off", async () => {
			const views = await holdIn(owner, Views, { session }, "editor");
			await views.open({ kind: "traces", title: "Traces" }, BACKGROUND_CONTEXT);
			views.release();
			await browser.metrics(1280, 900);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
			await browser.wait("document.querySelector('.traces-search')");
			assert.equal(
				await browser.evaluate<string>("document.getElementById('root').dataset.p2Telemetry ?? 'none'"),
				"none",
			);
			await browser.wait(
				"document.querySelector('.traces-search .notice.error')?.textContent.includes('telemetry is off')",
			);
		});
	});
});
