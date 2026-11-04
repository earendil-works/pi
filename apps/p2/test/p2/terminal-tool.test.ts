// The agent's terminal tool end to end with the fake provider and a real terminal host (skipped without a pi-env
// daemon build): code mode scripts drive the session's terminals, which are the owner's (listed, labeled, typed into
// by both); guest turns may use it; tmux errors come back as tool errors; the server serves only the session's current worker, on the session's environments, and archiving closes
// the session's terminals; a subagent's scripts open windows at its own location. Without code mode, `tool_search`
// loads the tool.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { AgentTerminals, TerminalServices, Terminals } from "../../plugins/terminals/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame, type TerminalEvent, type TerminalInfo } from "../../plugins/terminals/protocol.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { APP, expectChord, holdIn, http, poll, startFixture, until } from "./helpers.ts";

let unavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	unavailable = error instanceof Error ? error.message : "No pi-env daemon with terminal support";
}

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult"),
	);
const text = (result: ToolResultMessage | undefined) =>
	(result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
/** A completed code mode result's returned value. */
const returned = (result: ToolResultMessage): unknown => {
	const match = /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/.exec(text(result));
	assert.ok(match, `a completed script's result: ${text(result)}`);
	return JSON.parse(text(result).slice(match[0].length));
};

test(
	"the agent's terminal tool on the session's shared terminals",
	{ timeout: 180_000, skip: unavailable },
	async (t) => {
		const shell = process.env.SHELL;
		// The terminal host and its shells inherit this: a plain shell, without the developer's rc files.
		process.env.SHELL = "/bin/sh";
		const fixture = await startFixture({ allowedHosts: ["share.test"] });
		t.after(async () => {
			await fixture.close();
			const host = await connectTerminalHost(fixture.dataDir, APP);
			host.resume();
			host.write(encodeFrame({ type: "shutdown" }));
			await new Promise((resolve) => host.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
		});
		const workspace = realpathSync(fixture.workspace);
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: workspace, title: "Terminals" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		let serial = 0;
		const call = async (prompt: string, target = chat) => {
			const count = results(await until(target.view, Boolean)).length;
			await target.send({ text: prompt, requestId: `terminal-${++serial}` }, BACKGROUND_CONTEXT);
			return results(
				await until(
					target.view,
					(view) => results(view).length > count && !(view?.docs["pi.live"] as { run?: unknown })?.run,
				),
			).at(-1)!;
		};
		const script = async (code: string, target = chat) => {
			const result = await call(`codemode ${code}`, target);
			assert.equal(result.isError, false, text(result));
			return returned(result);
		};
		// The owner's terminal panel: its byte channel hears the session's terminals change.
		const view = await holdIn(owner, Terminals, { session: session.id, view: randomUUID() }, "owner");
		const bytes = await byteChannel(fixture.server.port, (await view.channel({}, BACKGROUND_CONTEXT)).token);
		t.after(() => bytes.socket.terminate());
		await view.list({}, BACKGROUND_CONTEXT);
		const listed = () =>
			bytes.events.findLast(
				(event): event is Extract<TerminalEvent, { type: "terminals" | "list" }> =>
					event.type === "terminals" || event.type === "list",
			)?.terminals ?? [];

		await t.test("a script opens a window, types into it and reads its output", async () => {
			const value = (await script(
				[
					'const opened = await tools.terminal({ command: "new-window", args: ["-n", "dev", "-w", "/^hello-agent$/", "echo hello-age\'\'nt"] });',
					'const sent = await tools.terminal({ command: "send-keys", args: ["-t", "dev", "-w", "/^two$/", "echo t\'\'wo", "Enter"] });',
					'const windows = await tools.terminal({ command: "list-windows" });',
					"return { opened, sent, windows };",
				].join("\n"),
			)) as {
				opened: { window: number; output: string; running: boolean };
				sent: { window: number; output: string; timedOut?: boolean };
				windows: { windows: { window: number; name?: string; opener: string; location: string }[] };
			};
			assert.equal(value.opened.window, 1);
			assert.equal(value.opened.running, true);
			assert.match(value.opened.output, /^hello-agent$/m);
			assert.match(value.sent.output, /^two$/m);
			assert.doesNotMatch(value.sent.output, /hello-agent/);
			assert.deepEqual(
				value.windows.windows.map(({ window, name, opener, location }) => ({ window, name, opener, location })),
				[{ window: 1, name: "dev", opener: "agent", location: workspace }],
			);
			// The owner's panel lists it, marked as the agent's.
			await poll(() => listed().some((terminal) => terminal.name === "dev" && terminal.agent === true));
		});

		await t.test("the owner types into the agent's window, the agent into the owner's", async () => {
			const dev = listed().find((terminal) => terminal.name === "dev") as TerminalInfo;
			await view.attach({ terminalId: dev.id }, BACKGROUND_CONTEXT);
			await poll(() => bytes.events.some((event) => event.type === "attached"));
			bytes.socket.send(Buffer.from("echo from-own''er\n"));
			const read = (await script(
				'return await tools.terminal({ command: "read", args: ["-t", "1", "-w", "/^from-owner$/"] });',
			)) as { output: string; timedOut?: boolean };
			assert.equal(read.timedOut, undefined);
			assert.match(read.output, /^from-owner$/m);
			// The owner opens a terminal; the agent sees and drives it.
			await view.open({ cols: 80, rows: 10, conversation: 1 }, BACKGROUND_CONTEXT);
			await poll(() => listed().length === 2);
			const value = (await script(
				[
					`const read = await tools.terminal({ command: "send-keys", args: ["-t", "2", "-w", "/^owned-by-user$/", "-l", "echo own''ed-by-user\\n"] });`,
					'const { windows } = await tools.terminal({ command: "list-windows" });',
					"return { read, windows };",
				].join("\n"),
			)) as { read: { output: string; timedOut?: boolean }; windows: { window: number; opener: string }[] };
			assert.equal(value.read.timedOut, undefined);
			assert.match(value.read.output, /^owned-by-user$/m);
			assert.deepEqual(
				value.windows.map(({ window, opener }) => [window, opener]),
				[
					[1, "agent"],
					[2, "user"],
				],
			);
		});

		await t.test("tmux errors and a missing window are tool errors", async () => {
			const value = (await script(
				[
					"const errors = [];",
					'for (const [command, args] of [["send-keys", ["-x"]], ["send-keys", ["Enter"]], ["read", ["-t", "9"]], ["capture-pane", ["-t", "1", "-S", "x"]]])',
					"  try { await tools.terminal({ command, args }); errors.push('no error'); } catch (error) { errors.push(String(error.message ?? error)); }",
					"return errors;",
				].join("\n"),
			)) as string[];
			assert.equal(value.length, 4);
			assert.match(value[0]!, /send-keys: unknown option -- x/);
			assert.match(value[1]!, /usage: send-keys/);
			assert.match(value[2]!, /can't find window: 9/);
			assert.match(value[3]!, /capture-pane: invalid start line: x/);
		});

		await t.test("guest turns may use it, like bash", async () => {
			const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
			const links = await until(sharing.links, (value) => Boolean(value?.length));
			const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
			const joined = await http(fixture.server.port, "/join", {
				method: "POST",
				headers,
				body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
			});
			const guest = fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
			const guestChat = await holdIn(guest, Chat, { session: session.id, conversation: 1 }, "participant");
			const value = (await script(
				'return await tools.terminal({ command: "capture-pane", args: ["-p", "-t", "dev"] });',
				guestChat,
			)) as { window: number; output: string };
			assert.equal(value.window, 1);
			assert.match(value.output, /from-owner/);
			// Guests still have no terminal panel.
			await expectChord(
				whenLive(guest.hold(Terminals, { session: session.id, view: randomUUID() }, BACKGROUND_CONTEXT)),
				"forbidden",
			);
		});

		await t.test("the server serves the session's current worker only, on its environments", async () => {
			const state = await fixture.server.host.root(
				async (ctx) => (await ctx.get(Hosts, {})).workers.value[session.id],
				BACKGROUND_CONTEXT,
			);
			assert.ok(state?.running);
			const as = (generation: number) =>
				holdIn(fixture.as({ kind: "worker", session: session.id, generation }), AgentTerminals, {}, "worker");
			const stale = await as(state.generation - 1);
			await expectChord(stale.list({}, BACKGROUND_CONTEXT), "forbidden");
			const current = await as(state.generation);
			assert.equal((await current.list({}, BACKGROUND_CONTEXT)).windows.length, 2);
			await expectChord(
				current.open({ key: "foreign", location: { cwd: "/", env: "gpu" } }, BACKGROUND_CONTEXT),
				"forbidden",
			);
			// The owner is no worker.
			await expectChord(whenLive(owner.hold(AgentTerminals, {}, BACKGROUND_CONTEXT)), "forbidden");
		});

		await t.test("a subagent's script opens windows at the subagent's own location", async () => {
			const own = join(workspace, "own");
			mkdirSync(own);
			const opener =
				'return await tools.terminal({ command: "new-window", args: ["-n", "sub", "-w", "/^in-sub$/", "echo in-s\'\'ub"] });';
			const spawn = { action: "spawn", name: "own", message: `codemode ${opener}`, cwd: "own" };
			const spawned = await call(`subagent ${JSON.stringify(spawn)}`);
			assert.equal(spawned.isError, false, text(spawned));
			// Its answer is reported to the main conversation; that turn ends before the next script.
			await until(
				chat.view,
				(value) =>
					JSON.stringify(value?.entries ?? []).includes("[subagent own answered") &&
					!(value?.docs["pi.live"] as { run?: unknown })?.run,
			);
			const { windows } = (await script('return await tools.terminal({ command: "list-windows" });')) as {
				windows: { name?: string; opener: string; location: string }[];
			};
			assert.deepEqual(
				windows.filter((window) => window.name === "sub").map(({ opener, location }) => ({ opener, location })),
				[{ opener: "agent", location: own }],
			);
		});

		await t.test("archiving the session closes its terminals", async () => {
			await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
			const service = (await fixture.server.host.registry(TerminalServices, BACKGROUND_CONTEXT)).value!.service;
			assert.deepEqual(await service.call({ op: "list", sessionId: session.id }), { kind: "list", windows: [] });
			await poll(() => listed().length === 0);
		});

		await t.test("without code mode, tool_search loads the tool for the model", async () => {
			const other = await sessions.create({ cwd: workspace, title: "No code mode" }, BACKGROUND_CONTEXT);
			const otherChat = await holdIn(owner, Chat, { session: other.id, conversation: 1 }, "participant");
			// Code mode on: the model is not offered it.
			assert.equal((await call(`terminal ${JSON.stringify({ command: "list-windows" })}`, otherChat)).isError, true);
			writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ codemode: false }));
			let found: ToolResultMessage | undefined;
			for (let attempt = 0; attempt < 20 && !(found && !found.isError); attempt++) {
				if (attempt > 0) await sleep(200);
				found = await call(`tool_search ${JSON.stringify({ query: "terminal tmux windows" })}`, otherChat);
			}
			assert.equal(found?.isError, false, text(found));
			assert.match(text(found), /- terminal: /);
			const direct = await call(`terminal ${JSON.stringify({ command: "list-windows" })}`, otherChat);
			assert.equal(direct.isError, false, text(direct));
			assert.equal(text(direct), "No windows.");
		});
	},
);

async function byteChannel(port: number, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?${new URLSearchParams({ token })}`);
	const events: TerminalEvent[] = [];
	socket.on("message", (data, binary) => {
		if (!binary) {
			const event = JSON.parse(data.toString()) as TerminalEvent | { type: "ping" };
			if (event.type !== "ping") events.push(event);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return { socket, events };
}
