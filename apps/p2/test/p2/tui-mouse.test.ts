import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocketServer } from "ws";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { launcherActions } from "../../src/hosts/tui-actions.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { defaultMouse } from "../../src/hosts/tui-local-preferences.ts";
import type { MousePolicy } from "../../src/hosts/tui-modes.ts";
import { SelectionGesture } from "../../src/hosts/tui-mouse.ts";
import type { TuiLocalPreferences } from "../../src/tui/preferences.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
const wheelUp = (x: number, y: number) => `\x1b[<64;${x};${y}M`;

test("selection gesture: a drag's or a multi-click's release, never a plain click, wheel or other button", () => {
	const gesture = new SelectionGesture();
	assert.equal(gesture.feed(press(5, 5), 0), false);
	assert.equal(gesture.feed(drag(9, 5), 10), false);
	assert.equal(gesture.feed(release(9, 5), 20), true, "drag");
	assert.equal(gesture.feed(press(20, 8), 2000), false);
	assert.equal(gesture.feed(release(20, 8), 2010), false, "single click");
	assert.equal(gesture.feed(press(20, 8), 2100), false);
	assert.equal(gesture.feed(release(20, 8), 2110), true, "double click");
	assert.equal(gesture.feed(release(1, 1), 3000), false, "release without a press");
	assert.equal(gesture.feed(wheelUp(3, 3) + wheelUp(3, 3), 4000), false, "wheel");
	assert.equal(gesture.feed("\x1b[<2;4;4M\x1b[<34;6;4M\x1b[<2;6;4m", 5000), false, "right button drag");
	assert.equal(gesture.feed(press(4, 4) + drag(4, 4) + release(4, 4), 6000), false, "motion without moving");
	assert.equal(defaultMouse({ TMUX: "/tmp/x" }), "on");
	assert.equal(defaultMouse({ TERM: "screen-256color" }), "on");
	assert.equal(defaultMouse({ TERM: "xterm-256color" }), "all");
});

/** Plays pi-tui: on every left release it requests the copy (as copy-on-select would with a selection). */
const FAKE_WORKER = `const seen=[];let id=0;export default ({send,onMessage})=>onMessage(message=>{
	if(message.kind==='snapshot')return seen;
	if(message.kind!=='resize')seen.push(message);
	if(message.kind==='activate'){
		send({kind:'navigation',session:'s1',conversation:1});
		send({kind:'output',data:'\\x1b[?1049h\\x1b[?7l\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1004h\\x1b[?1006hREADY'});
	}
	if(message.kind!=='input')return;
	if(/^\\x1b\\[<0;\\d+;\\d+m$/.test(message.data)||message.data==='w')
		send({kind:'request',id:++id,action:'copy.selection',payload:{text:'selected text'}});
});`;

async function fakeLauncher(
	t: { after(fn: () => unknown): void },
	mouse: MousePolicy,
	preferences?: Partial<TuiLocalPreferences>,
) {
	const version = createHash("sha256").update(FAKE_WORKER).digest("hex");
	const server = createServer((request, response) => {
		response.end(
			request.url === "/__p2_tui" ? JSON.stringify({ version, bundle: `/__p2_tui/${version}.mjs` }) : FAKE_WORKER,
		);
	});
	const sockets = new WebSocketServer({ server });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const url = new URL(`http://127.0.0.1:${address.port}`);
	const terminal = new VirtualTerminal(80, 24);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (data) => {
		writes.push(data);
		write(data);
	};
	const copies: string[] = [];
	const client = await startTuiClient({
		terminal,
		url,
		pollMs: 60000,
		colorQueryMs: 10,
		mouse,
		preferences: {
			current: { keybindings: {}, settings: {}, themes: {}, problems: [], ...preferences },
		},
		actions: launcherActions({
			url,
			credentials: {},
			role: "owner",
			clipboard: async (text) => {
				copies.push(text);
			},
		}),
	});
	t.after(() => client.close());
	await poll(() => writes.join("").includes("READY"));
	type Seen = { kind: string; data?: string; error?: string; input?: { mouse?: boolean } }[];
	const seen = async () => (await client.snapshot()) as Seen;
	return { client, terminal, writes, copies, seen };
}

test(
	"launcher: mouse reports reach the worker; pi-tui's copy is accepted only after the launcher saw the release",
	{ skip: !supported, timeout: 30000 },
	async (t) => {
		const { client, terminal, writes, copies, seen } = await fakeLauncher(t, "on");
		const responses = async () =>
			(await seen()).filter((message) => message.kind === "response") as { ok?: boolean; error?: string }[];
		assert(writes.join("").includes("\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h"));
		assert(!writes.join("").includes("\x1b[?1003h"), "all-motion needs the 'all' policy");
		// No gesture: a worker request on its own is denied.
		terminal.sendInput("w");
		await poll(async () => (await responses()).length === 1);
		// A wheel notch and a plain click: forwarded, the click's release opens no window.
		for (const data of [wheelUp(5, 5), press(5, 5), release(5, 5)]) terminal.sendInput(data);
		await poll(async () => (await responses()).length === 2);
		assert.deepEqual(copies, []);
		assert(
			(await responses()).every((response) => response.error === "denied"),
			"denied without the launcher's own gesture",
		);
		// A drag: the release the launcher saw permits exactly this copy.
		for (const data of [press(5, 5), drag(12, 6), release(12, 6)]) terminal.sendInput(data);
		await poll(async () => (await responses()).length === 3);
		assert.deepEqual(copies, ["selected text"]);
		assert.equal((await responses()).at(-1)?.ok, true);
		const inputs = (await seen()).filter((message) => message.kind === "input").map((message) => message.data);
		assert.deepEqual(inputs.slice(-3), [press(5, 5), drag(12, 6), release(12, 6)], "pi-tui selects in the worker");
		// The window is single-use.
		terminal.sendInput("w");
		await poll(async () => (await responses()).length === 4);
		assert.equal((await responses()).at(-1)?.error, "denied");
		assert.equal(copies.length, 1);
		writes.length = 0;
		await client.close();
		assert(writes.join("").includes("\x1b[?1000l\x1b[?1002l\x1b[?1004l\x1b[?1006l"));
	},
);

test(
	"launcher: with the mouse off pi-tui does not capture it and no gesture opens a copy window",
	{ skip: !supported, timeout: 30000 },
	async (t) => {
		const all = await fakeLauncher(t, "all");
		assert(all.writes.join("").includes("\x1b[?1003h"));
		const none = await fakeLauncher(t, "off");
		assert(!none.writes.join("").includes("\x1b[?1000h"));
		assert.equal((await none.seen()).find((message) => message.kind === "activate") ? 1 : 0, 1);
		for (const data of [press(5, 5), drag(12, 6), release(12, 6)]) none.terminal.sendInput(data);
		await poll(async () => (await none.seen()).some((message) => message.kind === "response"));
		assert.deepEqual(none.copies, []);
	},
);

test(
	"real worker: the wheel scrolls the transcript, a drag selects it, the release copies the selected text once",
	{ skip: !supported, timeout: 90000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const terminal = new VirtualTerminal(80, 16);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const copies: string[] = [];
		const client = await startTuiClient({
			terminal,
			url,
			credentials: { cookie: fixture.owner.cookie },
			pollMs: 60000,
			colorQueryMs: 10,
			mouse: "on",
			actions: launcherActions({
				url,
				credentials: { cookie: fixture.owner.cookie },
				role: "owner",
				clipboard: async (text) => {
					copies.push(text);
				},
			}),
		});
		t.after(() => client.close());
		const lines = async () => terminal.flushAndGetViewport();
		const screen = async () => (await lines()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000);
		assert(writes.join("").includes("\x1b[?1000h"), "pi-tui captures the mouse");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => !(await screen()).includes("Connecting conversation") && (await screen()).includes("•"));
		for (const word of ["alpha", "bravo", "charlie", "delta"]) {
			for (const char of word) terminal.sendInput(char);
			terminal.sendInput("\r");
			await poll(async () => (await screen()).includes(`Echo: ${word}`), 20000);
		}
		await poll(async () => !(await screen()).includes("Echo: alpha"));
		// Wheel up scrolls the transcript back (pi: "auto" lines per notch).
		for (let index = 0; index < 30 && !(await screen()).includes("Echo: alpha"); index++) {
			terminal.sendInput(wheelUp(10, 4));
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		await poll(async () => (await screen()).includes("Echo: alpha"), 5000, "scrolled up");
		// Drag across "Echo: alpha" selects it in pi-tui; the release copies it, once.
		const rows = await lines();
		const row = rows.findIndex((line) => line.includes("Echo: alpha"));
		const column = rows[row]!.indexOf("Echo: alpha");
		terminal.sendInput(press(column + 1, row + 1));
		terminal.sendInput(drag(column + 6, row + 1));
		terminal.sendInput(drag(column + 11, row + 1));
		assert.deepEqual(copies, []);
		terminal.sendInput(release(column + 11, row + 1));
		await poll(() => copies.length === 1);
		assert.equal(copies[0], "Echo: alpha");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(copies.length, 1);
		writes.length = 0;
		await client.close();
		assert(writes.join("").includes("\x1b[?1000l"), "mouse modes undone on exit");
	},
);
