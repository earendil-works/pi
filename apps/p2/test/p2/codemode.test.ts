// Durable code mode in p2 (fake provider): a script calling two tools end to end, its listed calls, a worker killed or
// stopped mid-script that resumes without rerunning finished calls, and the plugin removed mid-script.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { clientHost, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const codemodeResults = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		),
	);
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
/** The settled list of a code mode result: its script's tool calls (Durable writes it with the result). */
const detailCalls = (result: ToolResultMessage) => (result.details as CodemodeToolDetails | undefined)?.calls ?? [];
const codemodeCard = (view: ConversationView | null | undefined) =>
	buildTranscript(wholeView(view!))
		.items.flatMap((item) => (item.type === "assistant" ? item.tools : []))
		.findLast((tool) => tool.name === "codemode");
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A code mode result's text after its "Script completed" header (Durable's coding-agent layout). */
const scriptOutput = (text: string): string => {
	const match = /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/.exec(text);
	assert.ok(match, `a completed script's result: ${text}`);
	return text.slice(match[0].length);
};

describe("code mode (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	});
	after(async () => {
		await fixture?.close();
	});

	it("runs a script whose tool calls are nested durable calls, and lists them in its result", async () => {
		assert.ok(fixture.server.plugins.includes("codemode"));
		await chat.send({ text: "codemode", requestId: "c1" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => codemodeResults(value).length === 1 && !live(value)?.run);
		const result = codemodeResults(view)[0]!;
		assert.equal(result.isError, false, text(result));
		// Durable's coding-agent layout: a header, then each text item marked.
		assert.equal(scriptOutput(text(result)), "==> text 1/2 <==\nbash: written\n==> text 2/2 <==\nfirst\n");
		assert.equal(await readFile(join(fixture.workspace, "codemode.log"), "utf8"), "first\n");
		// Durable dropped the nested slots with the settled call; its result details list the calls.
		assert.equal(live(view)?.nestedTools, undefined);
		assert.deepEqual(
			detailCalls(result).map((call) => [call.id, call.name, call.status]),
			[
				[1, "bash", "ok"],
				[2, "read", "ok"],
			],
		);
		assert.equal(JSON.parse(detailCalls(result)[1]!.args).path, "codemode.log");
		// The transcript shows them as the codemode card's calls, in call order.
		assert.deepEqual(
			codemodeCard(view)?.calls?.map((call) => [call.id, call.name, call.status, call.depth]),
			[
				[`${result.toolCallId}/c1`, "bash", "done", 0],
				[`${result.toolCallId}/c2`, "read", "done", 0],
			],
		);
	});

	it("shows nested calls live while the script runs", async () => {
		await chat.send({ text: "codemode-restart", requestId: "c2" }, BACKGROUND_CONTEXT);
		const running = await until(chat.view, (value) =>
			Boolean(
				live(value)?.nestedTools?.some(
					(slot) => slot.status === "running" && String(slot.arguments.command).startsWith("sleep"),
				),
			),
		);
		const card = codemodeCard(running);
		assert.equal(card?.status, "running");
		assert.deepEqual(
			card?.calls?.map((call) => [call.name, call.status]),
			[
				["bash", "done"],
				["bash", "running"],
			],
		);
		// A compatible reload of code mode (and chat) keeps the sandbox: the script keeps waiting on its call.
		const sleeping = live(running)?.nestedTools?.find((slot) => String(slot.arguments.command).startsWith("sleep"));
		const report = await fixture.server.reload(["codemode", "chat"]);
		assert.equal(report.stopped, undefined);
		// The same nested call is still running after the commit (the view resets, then follows Durable again).
		const after = await until(chat.view, (value) =>
			Boolean(
				live(value)?.nestedTools?.some((slot) => slot.taskId === sleeping?.taskId && slot.status === "running"),
			),
		);
		assert.equal(codemodeResults(after).length, 1);
	});

	it("resumes the script after the worker is killed mid-call; finished calls do not run again", async () => {
		// The previous test left the script waiting in `sleep 5`: kill the worker process there.
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		const workers = await until(hosts.workers, (value) => Boolean(value?.[session]?.running && value[session]?.pid));
		const pid = workers![session]!.pid!;
		process.kill(pid, "SIGKILL");
		await until(hosts.workers, (value) => value?.[session]?.running === false);
		chat.release();
		// Opening the session again starts a worker; Durable resumes the replay-safe codemode call from its journal.
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const view = await until(chat.view, (value) => codemodeResults(value).length === 2 && !live(value)?.run, 30_000);
		const result = codemodeResults(view)[1]!;
		assert.equal(result.isError, false, text(result));
		assert.match(scriptOutput(text(result)), /^one \| two failed: .+ \| three$/);
		// `one` ran once, before the restart; the interrupted `two` was not rerun (bash is not replay-safe).
		assert.equal(await readFile(join(fixture.workspace, "codemode.log"), "utf8"), "first\none\nthree\n");
		// The result lists each call once, including the one finished before the restart.
		assert.deepEqual(
			detailCalls(result).map((call) => [call.id, call.status]),
			[
				[1, "ok"],
				[2, "error"],
				[3, "ok"],
			],
		);
		hosts.release();
	});

	it("resumes the script after a graceful server and worker restart", async () => {
		await chat.send({ text: "codemode-restart", requestId: "c3" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) =>
			Boolean(
				live(value)?.nestedTools?.some(
					(slot) => slot.status === "running" && String(slot.arguments.command).startsWith("sleep"),
				),
			),
		);
		chat.release();
		// Stopping closes the sandbox while the Harness is still open (holders are disposed first). Durable stores no
		// outcome for a run the sandbox ended on its own, so the restarted worker replays the script.
		await fixture.server.close();
		const restarted = await startServer({
			dataDir: fixture.dataDir,
			port: fixture.server.port,
			fake: true,
			web: false,
			plugins: fixture.server.plugins,
		});
		const client = clientHost(restarted.port);
		try {
			const again = await holdIn(client, Chat, { session, conversation: 1 }, "participant");
			const view = await until(
				again.view,
				(value) => codemodeResults(value).length === 3 && !live(value)?.run,
				30_000,
			);
			const result = codemodeResults(view)[2]!;
			assert.equal(result.isError, false, text(result));
			assert.match(scriptOutput(text(result)), /^one \| two failed: .+ \| three$/);
			assert.equal(
				await readFile(join(fixture.workspace, "codemode.log"), "utf8"),
				"first\none\nthree\none\nthree\n",
			);
		} finally {
			await client.close(BACKGROUND_CONTEXT);
			await restarted.close();
		}
	});
});
