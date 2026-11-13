import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocketServer } from "ws";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { filterTerminalOutput } from "../../src/hosts/tui-filter.ts";
import { Grants, type LauncherAction, PrivilegedKeys, parseTarget } from "../../src/hosts/tui-grants.ts";
import { TERMINAL_RESET, TerminalModes } from "../../src/hosts/tui-modes.ts";
import { TERMINAL_COLOR_QUERY } from "../../src/hosts/tui-terminal-colors.ts";
import { TrustedUi, visibleText } from "../../src/hosts/tui-trusted-ui.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
const CTRL_X = "\x18";
const ESC = "\x1b";

test("terminal modes: ?7 admitted, mouse only by policy, tracked, undone on cleanup and restored after launcher UI", () => {
	assert.equal(filterTerminalOutput("\x1b[?7l\x1b[?1000h"), "\x1b[?7l");
	const off = new TerminalModes();
	assert.equal(off.filter("a\x1b[?7l\x1b[?1000h\x1b[?1003h\x1b[?2004h\x1b[?25lb"), "a\x1b[?7l\x1b[?2004h\x1b[?25lb");
	assert.equal(off.restore(), "\x1b[?7l\x1b[?2004h\x1b[?25l");
	const cleanup = off.cleanup();
	assert(cleanup.startsWith("\x1b[?7h\x1b[?2004l\x1b[?25h"), JSON.stringify(cleanup));
	assert(cleanup.endsWith(TERMINAL_RESET));
	assert.equal(off.restore(), "", "cleanup forgets the worker's state");
	const on = new TerminalModes("on");
	assert.equal(on.filter("\x1b[?1000h\x1b[?1006h\x1b[?1003h"), "\x1b[?1000h\x1b[?1006h");
	assert(on.cleanup().startsWith("\x1b[?1000l\x1b[?1006l"));
	assert.equal(new TerminalModes("all").filter("\x1b[?1003h"), "\x1b[?1003h");
	for (const mode of ["1000", "1002", "1003", "1006", "1004", "2004", "2026", "1049"])
		assert(TERMINAL_RESET.includes(`\x1b[?${mode}l`), mode);
	assert(
		TERMINAL_RESET.includes("\x1b[?7h") && TERMINAL_RESET.includes("\x1b[?25h") && TERMINAL_RESET.includes("\x1b[r"),
	);
});

test("terminal modes: the kitty keyboard flags are pushed on the alternate screen and popped before leaving it", () => {
	const PUSH = "\x1b[>7u";
	const POP = "\x1b[<u";
	const modes = new TerminalModes();
	assert.equal(modes.keyboard(true), "", "the main screen has the launcher's own push");
	modes.filter("\x1b[?1049h");
	assert.equal(modes.keyboard(false), "", "nothing without the kitty protocol");
	assert.equal(modes.keyboard(true), PUSH);
	assert.equal(modes.keyboard(true), "", "once per alternate screen");
	// The worker leaves the alternate screen: the pop comes first, on the screen that has the push.
	assert.equal(modes.filter("a\x1b[?1049lb"), `a${POP}\x1b[?1049lb`);
	assert.equal(modes.keyboard(true), "");
	modes.filter("\x1b[?1049h");
	assert.equal(modes.keyboard(true), PUSH);
	// Suspend leaves the screen (pop), resume re-enters it and the next keyboard() pushes again.
	assert(modes.suspendSequence().startsWith(POP));
	assert(modes.resumeSequence().startsWith("\x1b[?1049h"));
	assert.equal(modes.keyboard(true), PUSH);
	assert(modes.cleanup().startsWith(POP));
	assert(!modes.cleanup().includes(POP), "popped once");
});

test("trusted UI: only Enter or y confirms; data is shown with visible control characters", async () => {
	const written: string[] = [];
	const ui = new TrustedUi({ write: (data) => written.push(data), columns: 60, rows: 12 }, "https://server.test");
	let closed = 0;
	ui.onClose = () => closed++;
	const first = ui.confirm({ action: "Copy", preview: "line\x1b]52;c;evil\x07\nsecond" });
	assert(ui.active);
	const screen = written.join("");
	assert(screen.includes("Server: https://server.test"));
	assert(screen.includes("line␛]52;c;evil␇"));
	assert(!screen.includes("\x1b]52"));
	for (const key of ["a", " ", "\x1b[A", "\x1b[6~", "\x04"]) ui.handleInput(key);
	assert(ui.active, "unrelated keys neither confirm nor cancel");
	ui.handleInput(ESC);
	assert.equal(await first, false);
	const second = ui.confirm({ action: "Copy" });
	assert.equal(await ui.confirm({ action: "Other" }), false, "one interaction at a time");
	ui.handleInput("n");
	assert.equal(await second, false);
	const third = ui.confirm({ action: "Copy" });
	ui.handleInput("y");
	assert.equal(await third, true);
	const fourth = ui.confirm({ action: "Copy" });
	ui.handleInput("\r");
	assert.equal(await fourth, true);
	assert.equal(closed, 4);
	assert.equal(visibleText("\x00\x9b\x7f"), "␀\ufffd␡");
});

test("grants bind to the worker and target; swaps, navigation and expiry cancel them", () => {
	const grants = new Grants("https://server.test");
	const worker = {};
	const other = {};
	const target = { session: "s", conversation: 1 };
	const grant = grants.create("copy", "C", worker, target);
	assert(grants.valid(grant.id, worker, "copy"));
	assert.equal(grants.valid(grant.id, other), undefined, "another worker cannot use it");
	assert.equal(grants.valid(grant.id, worker, "openUrl"), undefined, "nor another action");
	grants.navigate(worker, target);
	assert(grants.valid(grant.id, worker));
	grants.navigate(worker, { session: "s", conversation: 2 });
	assert.equal(grants.valid(grant.id, worker), undefined);
	assert(grant.signal.aborted);
	const swapped = grants.create("copy", "K", worker, undefined);
	grants.cancelWorker(worker);
	assert(swapped.signal.aborted);
	const expired = grants.create("copy", "C", worker, undefined, -1);
	assert.equal(grants.valid(expired.id, worker), undefined);
	assert.equal(grants.size, 0);
	assert.deepEqual(parseTarget({ session: "abc-1", conversation: 2 }), { session: "abc-1", conversation: 2 });
	assert.equal(parseTarget({ session: "../x", conversation: 1 }), undefined);
	assert.equal(parseTarget({ session: "s", conversation: 0 }), undefined);
});

test("privileged keys: only registered actions are intercepted, with the visitor's local bindings", () => {
	const platform = { platform: "linux", windowsKeys: false };
	const keys = new PrivilegedKeys({}, platform, ["app.message.copy"]);
	assert.deepEqual(keys.match(CTRL_X), { id: "app.message.copy", release: false });
	assert.equal(keys.match("\x16"), undefined, "Ctrl+V has no registered action here");
	assert.equal(keys.match("x"), undefined);
	const rebound = new PrivilegedKeys({ "app.message.copy": "f9" }, platform, ["app.message.copy"]);
	assert.equal(rebound.match(CTRL_X), undefined);
	assert.equal(rebound.match("\x1b[20~")?.id, "app.message.copy");
	// Ctrl+Y is pi's yank: a privileged action bound there loses it.
	assert.equal(
		new PrivilegedKeys({ "app.message.copy": "ctrl+y" }, platform, ["app.message.copy"]).match("\x19"),
		undefined,
	);
	// A local binding that takes the key for a non-privileged action wins over the launcher action (rule 2).
	const lost = new PrivilegedKeys({ "app.model.select": "ctrl+x" }, platform, ["app.message.copy"]);
	assert.equal(lost.match(CTRL_X), undefined);
});

/** A scriptable fake worker: keys typed in the terminal drive it; its snapshot is everything it received. */
const FAKE_WORKER = `const seen=[];export default ({send,onMessage})=>onMessage(message=>{
	if(message.kind==='snapshot')return seen;
	if(message.kind==='grantRequest')return {text:'from-worker'};
	if(message.kind!=='resize')seen.push(message);
	if(message.kind==='activate')send({kind:'output',data:'\\x1b[?1049h\\x1b[?7l\\x1b[?2004h\\x1b[?1000hREADY'});
	if(message.kind!=='input')return;
	const d=message.data;
	if(d==='r')send({kind:'request',id:seen.length,action:'test.confirm',payload:{text:'hello'}});
	if(d==='q')send({kind:'request',id:seen.length,action:'unknown.action',payload:{}});
	if(d==='w')send({kind:'request',id:seen.length,action:'test.unasked',payload:{}});
	if(d==='o')send({kind:'output',data:'WORKER-OUTPUT'});
	if(d==='s')send({kind:'keyContext',suspendPrivileged:true});
	if(d==='u')send({kind:'keyContext',suspendPrivileged:false});
	if(d==='1')send({kind:'navigation',session:'s1',conversation:1});
	if(d==='2')send({kind:'navigation',session:'s2',conversation:1});
	if(d==='t'){for(let i=0;i<10;i++)send({kind:'title',text:'T'+i+'\\x1b]52;c;x\\x07'});}
	if(d==='x')process.exit(3);
});`;

async function fakeServer(t: { after(fn: () => unknown): void }, source: () => string) {
	const server = createServer((request, response) => {
		const version = createHash("sha256").update(source()).digest("hex");
		response.setHeader("Content-Type", request.url === "/__p2_tui" ? "application/json" : "text/javascript");
		response.end(
			request.url === "/__p2_tui" ? JSON.stringify({ version, bundle: `/__p2_tui/${version}.mjs` }) : source(),
		);
	});
	const sockets = new WebSocketServer({ server });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	t.after(async () => {
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return new URL(`http://127.0.0.1:${address.port}`);
}

test(
	"isolation: C actions need local confirmation, K actions fire only on their key, worker IO is suspended",
	{ skip: !supported, timeout: 30000 },
	async (t) => {
		let source = FAKE_WORKER;
		const url = await fakeServer(t, () => source);
		const terminal = new VirtualTerminal(80, 24);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const titles: string[] = [];
		Object.assign(terminal, { setTitle: (title: string) => titles.push(title) });
		const ran: string[] = [];
		const keyed: string[] = [];
		const actions: Record<string, LauncherAction> = {
			"test.confirm": {
				kind: "C",
				consent: (payload) =>
					payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string"
						? { action: "Use the text", preview: payload.text }
						: undefined,
				run: async (payload, context) => {
					ran.push(`${JSON.stringify(payload)}@${context.grant.target?.session}`);
					return "done";
				},
			},
			"test.unasked": {
				kind: "C",
				consent: () => ({ action: "Restart the server", ask: false }),
				run: async () => {
					ran.push("unasked");
					return "restarted";
				},
			},
			"test.key": {
				kind: "K",
				key: "app.message.copy",
				run: async (context) => {
					keyed.push(JSON.stringify(await context.ask("copyText")));
				},
			},
		};
		const client = await startTuiClient({ terminal, url, pollMs: 60000, colorQueryMs: 10, actions });
		t.after(() => client.close());
		const seen = async () => (await client.snapshot()) as { kind: string; data?: string; id?: number }[];
		const responses = async () => (await seen()).filter((message) => message.kind === "response");
		await poll(() => writes.join("").includes("READY"));
		assert(!writes.join("").includes("\x1b[?1000h"), "mouse modes need the visitor's policy");

		// K: the privileged key fires its action and never reaches the worker; other keys do.
		terminal.sendInput(CTRL_X);
		await poll(() => keyed.length === 1);
		assert.equal(keyed[0], JSON.stringify({ text: "from-worker" }));
		terminal.sendInput("z");
		await poll(async () => (await seen()).some((message) => message.data === "z"));
		assert(!(await seen()).some((message) => message.data === CTRL_X));
		// Rule 3: a suspended context forwards it (e.g. search-next) and nothing fires.
		terminal.sendInput("s");
		await poll(async () => (await seen()).some((message) => message.data === "s"));
		terminal.sendInput(CTRL_X);
		await poll(async () => (await seen()).some((message) => message.data === CTRL_X));
		assert.equal(keyed.length, 1);
		terminal.sendInput("u");

		// C: denied with Escape, with n; never run without a confirmation; worker output and input suspended.
		terminal.sendInput("1");
		for (const cancel of [ESC, "n"]) {
			const answered = (await responses()).length;
			terminal.sendInput("r");
			await poll(() => writes.join("").includes("Action: Use the text"));
			writes.length = 0;
			const before = (await seen()).length;
			terminal.sendInput("o");
			terminal.sendInput("a");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal((await seen()).length, before, "input is consumed by the launcher UI");
			terminal.sendInput(cancel);
			await poll(async () => (await responses()).length === answered + 1);
			assert.equal((await seen()).at(-2)?.kind, "redraw", "a full redraw follows launcher UI");
			assert.deepEqual(ran, []);
			assert(!writes.join("").includes("WORKER-OUTPUT"));
			assert.match(JSON.stringify((await responses()).at(-1)), /"error":"denied"/);
		}
		const denied = (await responses()).length;
		terminal.sendInput("r");
		await poll(() => writes.join("").includes("hello"));
		terminal.sendInput("\r");
		await poll(async () => (await responses()).length === denied + 1);
		assert.deepEqual(ran, ['{"text":"hello"}@s1']);
		assert(JSON.stringify((await responses()).at(-1)).includes('"done"'));

		// Navigation while the consent shows cancels the grant: confirming then runs nothing.
		terminal.sendInput("r");
		await poll(() => writes.join("").includes("Session: s1 #1"));
		client.sandbox!.post({ kind: "input", data: "2" });
		await poll(async () => (await seen()).some((message) => message.data === "2"));
		terminal.sendInput("y");
		await poll(async () => JSON.stringify((await responses()).at(-1)).includes('"cancelled"'));
		assert.equal(ran.length, 1);
		// ask: false runs at once, without the screen.
		writes.length = 0;
		terminal.sendInput("w");
		await poll(async () => JSON.stringify((await responses()).at(-1)).includes('"restarted"'));
		assert.deepEqual(ran.slice(1), ["unasked"]);
		assert(!writes.join("").includes("Action: Restart the server"), "no consent screen");
		// Unknown actions are denied without any UI.
		terminal.sendInput("q");
		await poll(async () => JSON.stringify((await responses()).at(-1)).includes('"denied"'));

		// N: titles are sanitized and rate limited.
		terminal.sendInput("t");
		await poll(() => titles.length >= 4);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(titles.length, 4);
		assert(!titles.join("").includes("\x1b"));
		await poll(() => titles.length === 5, 3000, "the latest throttled title");
		assert.equal(titles.at(-1), "T9 ]52;c;x ");

		// Swap: the old worker's modes are undone before the new one starts.
		writes.length = 0;
		source = `${FAKE_WORKER}//v2`;
		await client.reload();
		await poll(() => writes.join("").includes("READY"));
		const swap = writes.join("");
		assert(swap.indexOf("\x1b[?7h") < swap.indexOf("READY") && swap.includes("\x1b[?2004l\x1b[?25h"));
		// Crash: the launcher closes and resets everything.
		writes.length = 0;
		terminal.sendInput("x");
		await poll(() => writes.join("").includes(TERMINAL_RESET));
		assert(writes.join("").replaceAll(TERMINAL_COLOR_QUERY, "").includes("\x1b[?7h"));
	},
);

test(
	"kitty keyboard: the launcher's negotiated protocol reaches the worker, which decodes keys accordingly",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		type Snapshot = { session?: string; screen?: string; drafts: [string, string][] };
		const typeInto = async (kitty: boolean): Promise<{ draft: string; screen: string }> => {
			await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
			const terminal = new VirtualTerminal(100, 30);
			// VirtualTerminal reports kitty as active; the launcher forwards whatever its terminal negotiated.
			Object.defineProperty(terminal, "kittyProtocolActive", { get: () => kitty });
			const client = await startTuiClient({
				terminal,
				url: new URL(`http://127.0.0.1:${fixture.server.port}`),
				credentials: { cookie: fixture.owner.cookie },
				pollMs: 60000,
				colorQueryMs: 10,
			});
			try {
				const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
				await poll(async () => (await screen()).includes("New session"), 15000);
				// The newest session is first after "+ New session".
				terminal.sendInput("\x1b[B");
				terminal.sendInput("\r");
				await poll(async () => ((await client.snapshot()) as Snapshot).screen === "chat");
				await poll(async () => !(await screen()).includes("Connecting conversation"));
				terminal.sendInput("a");
				terminal.sendInput("\x1b\r");
				terminal.sendInput("b");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const { session, drafts } = (await client.snapshot()) as Snapshot;
				return { draft: drafts.find(([id]) => id === `${session}#1`)?.[1] ?? "", screen: await screen() };
			} finally {
				await client.close();
			}
		};
		// Kitty: ESC CR is Kitty's shift+enter mapping, a newline. Legacy: it is alt+enter, the follow-up that sends "a".
		const kitty = await typeInto(true);
		assert.equal(kitty.draft, "a\nb");
		assert(!kitty.screen.includes("Echo: a"));
		assert((await typeInto(false)).screen.includes("Echo: a"));
	},
);

test(
	"keyContext: while transcript search has focus the worker suspends interception, so Ctrl+G is search-next",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		let edited = 0;
		const terminal = new VirtualTerminal(100, 30);
		const client = await startTuiClient({
			terminal,
			url: new URL(`http://127.0.0.1:${fixture.server.port}`),
			credentials: { cookie: fixture.owner.cookie },
			pollMs: 60000,
			colorQueryMs: 10,
			actions: {
				"test.editor": {
					kind: "K",
					key: "app.editor.external",
					run: async () => {
						edited++;
					},
				},
			},
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => !(await screen()).includes("Connecting conversation") && (await screen()).includes("•"));
		terminal.sendInput("\x07");
		await poll(() => edited === 1);
		// Ctrl+Shift+F (kitty-encoded) opens the transcript search; the worker reports the suspension.
		terminal.sendInput("\x1b[102;6u");
		await new Promise((resolve) => setTimeout(resolve, 300));
		terminal.sendInput("\x07");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(edited, 1, "Ctrl+G went to the search");
		terminal.sendInput("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 300));
		terminal.sendInput("\x07");
		await poll(() => edited === 2);
	},
);
