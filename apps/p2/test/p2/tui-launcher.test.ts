import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocketServer } from "ws";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { claimOwner } from "../../src/hosts/tui-config.ts";
import { TERMINAL_COLOR_QUERY } from "../../src/hosts/tui-terminal-colors.ts";
import { cookieTransport, type TuiTransport } from "../../src/hosts/tui-transport.ts";
import { DARK_THEME } from "../../src/tui/theme/builtin-themes.ts";
import { holdIn, http, poll, startFixture, until } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
type Snapshot = { session?: string; drafts: [string, string][]; screen: string };

test(
	"server-shipped TUI drives create/send, queues, stop, worker replacement and reconnect",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		let restarted: Awaited<ReturnType<typeof startServer>> | undefined;
		t.after(async () => {
			await restarted?.close();
			await fixture.close();
		});
		// Server defaults sit below the visitor's local preferences; privileged bindings never come from the server.
		writeFileSync(
			join(fixture.dataDir, "tui.json"),
			JSON.stringify({
				keybindings: { "app.model.select": "ctrl+g", "app.clipboard.pasteImage": "f3" },
				theme: "light",
			}),
		);
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const token = (await fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
		const credentials = await claimOwner(url, token, {});
		const terminal = new VirtualTerminal(100, 30);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const failures: string[] = [];
		// Local preferences arrive as data (the worker cannot read files): a binding and a custom theme.
		const mine = { ...DARK_THEME, name: "mine", colors: { ...DARK_THEME.colors, accent: "#123456" } };
		const client = await startTuiClient({
			terminal,
			url,
			credentials,
			reconnectMs: 20,
			pollMs: 50,
			colorQueryMs: 10,
			capabilities: { trueColor: true, platform: "linux", windowsKeys: false },
			preferences: {
				current: {
					keybindings: { "app.model.select": "f2" },
					theme: "mine",
					settings: {},
					themes: { mine },
					problems: [],
				},
			},
			onFailure: (message) => failures.push(message),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000, "bundled sessions surface");
		assert.equal(failures.length, 0);
		await poll(() => writes.join("").includes("38;2;18;52;86"), 5000, "custom theme accent");
		terminal.sendInput("\x07");
		terminal.sendInput("\x1bOR");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert(!(await screen()).includes("Choose default model"), "local F2 overrides the server's Ctrl+G");
		terminal.sendInput("\x1bOQ");
		await poll(async () => (await screen()).includes("Choose default model"));
		terminal.sendInput("\x1b");
		await poll(async () => (await screen()).includes("New session"));
		terminal.sendInput("\r");
		terminal.sendInput("\x01");
		terminal.sendInput("\x0b");
		for (const char of fixture.workspace) terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => Boolean(((await client.snapshot()) as Snapshot).session));
		await poll(async () => ((await client.snapshot()) as Snapshot).screen === "chat");
		// Keys reach the editor only once the conversation is live for this participant.
		await poll(async () => !(await screen()).includes("Connecting conversation"));
		for (const char of "hello terminal") terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Echo: hello terminal"), 20000, "bundled chat answer");
		// pi's footer: conversation context against the owner's model catalog, model on the right.
		await poll(async () => /\d%\/\d/.test(await screen()));
		assert((await screen()).includes("(faux) faux-1"));
		for (const char of "unsent draft") terminal.sendInput(char);
		const oldWorker = client.sandbox!.worker;
		let exited = false;
		oldWorker.once("exit", () => {
			exited = true;
		});
		await client.reload();
		assert.notEqual(client.sandbox!.worker, oldWorker);
		assert(exited);
		await poll(async () => (await screen()).includes("unsent draft"));
		const selected = ((await client.snapshot()) as Snapshot).session;
		assert(selected);
		assert.equal(
			((await client.snapshot()) as Snapshot).drafts.find(([id]) => id === `${selected}#1`)?.[1],
			"unsent draft",
		);
		terminal.resize(80, 24);
		terminal.sendInput("\x15");
		for (const char of "slow stream") terminal.sendInput(char);
		terminal.sendInput("\r");
		// pi's working indicator in the editor border.
		await poll(async () => (await screen()).includes("Working..."));
		for (const char of "queued text") terminal.sendInput(char);
		// Alt+Enter in kitty's encoding: the virtual terminal reports the kitty protocol, which the worker now knows.
		terminal.sendInput("\x1b[13;3u");
		await poll(async () => (await screen()).includes("Follow-up: queued text"));
		terminal.sendInput("\x1b[1;3A");
		await poll(async () =>
			((await client.snapshot()) as Snapshot).drafts.some(([, text]) => text.includes("queued text")),
		);
		terminal.sendInput("\x1b");
		await poll(async () => !(await screen()).includes("Working..."));
		await fixture.server.close();
		await poll(() => !client.connected);
		restarted = await startServer({
			dataDir: fixture.dataDir,
			port: fixture.server.port,
			fake: true,
			web: false,
			plugins: fixture.server.plugins,
		});
		await poll(
			async () =>
				client.connected &&
				(await screen()).includes("Echo: hello terminal") &&
				(await screen()).includes("queued text"),
			20000,
			"launcher reconnect",
		);
		assert.equal(((await client.snapshot()) as Snapshot).session, selected);
		assert.deepEqual(failures, []);
	},
);

test(
	"a link that went silent without a close (a laptop slept, the relay dropped it) reconnects",
	{ skip: !supported, timeout: 90000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const token = (await fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
		const direct = cookieTransport(url, await claimOwner(url, token, {}));
		let silent = false;
		let sockets = 0;
		// The first socket dies silently: once `silent`, nothing arrives or leaves, and the far end's close never
		// arrives either; only terminating it here ends it.
		const transport: TuiTransport = {
			request: direct.request,
			socket: (path, events) => {
				sockets++;
				const dies = sockets === 1;
				let gone = false;
				let terminated = false;
				let ended = false;
				const end = () => {
					if (ended) return;
					ended = true;
					events.close();
				};
				const inner = direct.socket(path, {
					open: () => events.open(),
					refused: (status) => events.refused(status),
					message: (data, binary) => {
						if (!(dies && silent)) events.message(data, binary);
					},
					close: () => {
						gone = true;
						if (!(dies && silent) || terminated) end();
					},
				});
				return {
					get open() {
						return inner.open;
					},
					send: (data) => {
						if (!(dies && silent)) inner.send(data);
					},
					terminate: () => {
						terminated = true;
						inner.terminate();
						if (gone) end();
					},
				};
			},
		};
		const terminal = new VirtualTerminal(100, 30);
		const failures: string[] = [];
		const client = await startTuiClient({
			terminal,
			url,
			transport,
			reconnectMs: 20,
			pollMs: 50,
			colorQueryMs: 10,
			capabilities: { trueColor: true, platform: "linux", windowsKeys: false },
			onFailure: (message) => failures.push(message),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000, "bundled sessions surface");
		terminal.sendInput("\r");
		terminal.sendInput("\x01");
		terminal.sendInput("\x0b");
		for (const char of fixture.workspace) terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => ((await client.snapshot()) as Snapshot).screen === "chat");
		await poll(async () => !(await screen()).includes("Connecting conversation"));
		silent = true;
		// Chord's heartbeat in the worker closes the silent link after 30 s; the launcher then drops the socket.
		await poll(() => sockets === 2 && client.connected, 60000, "a second socket after the silent one");
		await poll(
			async () => !(await screen()).includes("Connecting conversation"),
			15000,
			"the conversation is live again",
		);
		assert.deepEqual(failures, []);
	},
);

test(
	"a click on the editor keeps keys on the runtime: Ctrl+C still clears and the screen still switches",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const token = (await fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
		const terminal = new VirtualTerminal(100, 30);
		const client = await startTuiClient({
			terminal,
			url,
			credentials: await claimOwner(url, token, {}),
			mouse: "on",
			pollMs: 60000,
			colorQueryMs: 10,
			capabilities: { trueColor: true, platform: "linux", windowsKeys: false },
		});
		t.after(() => client.close());
		const viewport = () => terminal.flushAndGetViewport();
		const screen = async () => (await viewport()).join("\n");
		const draft = async () => {
			const snapshot = (await client.snapshot()) as Snapshot;
			return snapshot.drafts.find(([id]) => id === `${snapshot.session}#1`)?.[1];
		};
		await poll(async () => (await screen()).includes("New session"), 15000, "bundled sessions surface");
		terminal.sendInput("\r");
		terminal.sendInput("\x01");
		terminal.sendInput("\x0b");
		for (const char of fixture.workspace) terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => ((await client.snapshot()) as Snapshot).screen === "chat");
		await poll(async () => !(await screen()).includes("Connecting conversation"));
		for (const char of "clicked draft") terminal.sendInput(char);
		await poll(async () => (await draft()) === "clicked draft");
		// An SGR click on the editor's line: pi-tui would focus the editor itself, bypassing the runtime's commands.
		const row = (await viewport()).findIndex((line) => line.includes("clicked draft")) + 1;
		assert(row > 0);
		terminal.sendInput(`\x1b[<0;4;${row}M`);
		terminal.sendInput(`\x1b[<0;4;${row}m`);
		terminal.sendInput("!");
		await poll(async () => (await draft())?.includes("!") === true);
		// Ctrl+C (kitty encoding; the virtual terminal reports the protocol) is app.clear.
		terminal.sendInput("\x1b[99;5u");
		await poll(async () => (await draft()) === "", 5000, "Ctrl+C clears the editor after a click");
		// Ctrl+R (p2.sessions) opens the sessions screen, whose search gets the next keys, not the chat draft.
		terminal.sendInput("\x1b[114;5u");
		await poll(async () => ((await client.snapshot()) as Snapshot).screen === "sessions");
		terminal.sendInput("x");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(await draft(), "");
	},
);

test("TUI admission matches web: strangers refused, associated owners and share guests admitted", async (t) => {
	const fixture = await startFixture({ allowedHosts: ["tui.test"] });
	t.after(() => fixture.close());
	const port = fixture.server.port;
	const anonymous = await http(port, "/__p2_tui", { headers: { Host: "tui.test" } });
	assert.equal(anonymous.status, 401);
	assert(!anonymous.body.includes("export default"));
	const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
		{ cwd: fixture.workspace },
		BACKGROUND_CONTEXT,
	);
	const sharing = fixture.browser().hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
	await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
	const links = await until(sharing.links, (value) => Boolean(value?.length));
	assert(links?.[0]);
	const shareToken = new URL(links[0].url).pathname.split("/").at(-1)!;
	const joined = await http(port, "/join", {
		method: "POST",
		headers: { Host: "tui.test", Origin: "https://tui.test", "Content-Type": "application/json" },
		body: JSON.stringify({ token: shareToken, name: "TUI guest" }),
	});
	assert.equal(joined.status, 200);
	const cookie = String(joined.headers["set-cookie"]).split(";")[0]!;
	const manifestResponse = await http(port, "/__p2_tui", { headers: { Host: "tui.test", Cookie: cookie } });
	assert.equal(manifestResponse.status, 200);
	const manifest = JSON.parse(manifestResponse.body) as { version: string; bundle: string };
	assert.match(manifest.version, /^[a-f0-9]{64}$/);
	assert.equal((await http(port, manifest.bundle, { headers: { Host: "tui.test", Cookie: cookie } })).status, 200);
	assert.equal((await http(port, manifest.bundle, { headers: { Host: "tui.test" } })).status, 401);
});

test(
	"changed server facet bundle swaps worker after readiness; invalid reload keeps the old version",
	{ skip: !supported, timeout: 30000 },
	async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "p2-tui-bundle-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		mkdirSync(join(directory, "sessions"));
		const file = join(directory, "sessions/tui.ts");
		const module = fileURLToPath(new URL("../../src/runtime/tui.ts", import.meta.url));
		const source = (label: string) =>
			`import {tuiFacet} from ${JSON.stringify(module)};process.stdout.write("raw-output\\x1b]52;c;raw\\x07");process.stderr.write("raw-error");export default tuiFacet("sessions",()=>({render:()=>[${JSON.stringify(label)}],invalidate(){},dispose(){}}));`;
		writeFileSync(file, source("Original server facet"));
		const fixture = await startFixture({ tuiDirectory: directory });
		t.after(() => fixture.close());
		const terminal = new VirtualTerminal();
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const failures: string[] = [];
		const client = await startTuiClient({
			terminal,
			url: new URL(`http://127.0.0.1:${fixture.server.port}`),
			pollMs: 25,
			onFailure: (message) => failures.push(message),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("Original server facet"));
		const original = client.version;
		const originalWorker = client.sandbox!.worker;
		let exited = false;
		originalWorker.once("exit", () => {
			exited = true;
		});
		writeFileSync(file, "export default ???");
		await assert.rejects(fixture.server.reload(["sessions"]));
		assert.equal(client.version, original);
		assert((await screen()).includes("Original server facet"));
		writeFileSync(file, source("Changed server facet"));
		await fixture.server.reload(["sessions"]);
		await poll(() => client.version !== original);
		await poll(async () => (await screen()).includes("Changed server facet"));
		assert(exited);
		assert.notEqual(client.sandbox!.worker, originalWorker);
		const previousVersion = client.version;
		writeFileSync(file, source("safe\x1b]52;c;evil\x07"));
		await fixture.server.reload(["sessions"]);
		await poll(() => client.version !== previousVersion);
		await poll(async () => (await screen()).includes("safe"));
		assert(!writes.join("").replaceAll(TERMINAL_COLOR_QUERY, "").includes("\x1b]"));
		assert(!writes.join("").includes("raw-output"));
		assert(!writes.join("").includes("raw-error"));
		assert.deepEqual(failures, []);
	},
);

test(
	"launcher denies unknown capabilities, hides cookies and closes a preparing worker",
	{ skip: !supported, timeout: 15000 },
	async (t) => {
		let source = `export default ({input,send,onMessage})=>onMessage(message=>{
		if(message.kind==='snapshot')return input;
		if(message.kind==='activate'){
			for(const kind of ['readFile','writeFile','clipboard','openUrl','spawn'])send({kind,path:'/private',url:'file:///private'});
			send({kind:'output',data:'safe\\x1b]52;c;ignored\\x07'});
			process.stdout.write('raw-output');process.stderr.write('raw-error');
		}
	});`;
		let bundleRequests = 0;
		const version = () => createHash("sha256").update(source).digest("hex");
		const server = createServer((request, response) => {
			assert.equal(request.headers.cookie, "owner=fixture-only");
			response.setHeader("Content-Type", request.url === "/__p2_tui" ? "application/json" : "text/javascript");
			if (request.url === "/__p2_tui")
				response.end(JSON.stringify({ version: version(), bundle: `/__p2_tui/${version()}.mjs` }));
			else {
				bundleRequests++;
				response.end(source);
			}
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
		const terminal = new VirtualTerminal();
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		let stopped = 0;
		const stop = terminal.stop.bind(terminal);
		terminal.stop = () => {
			stopped++;
			stop();
		};
		const client = await startTuiClient({
			terminal,
			url: new URL(`http://127.0.0.1:${address.port}`),
			credentials: { cookie: "owner=fixture-only" },
			pollMs: 60000,
		});
		t.after(() => client.close());
		await poll(() => writes.includes("safe"));
		assert.deepEqual(await client.snapshot(), {
			columns: 80,
			rows: 24,
			origin: `http://127.0.0.1:${address.port}`,
			mouse: false,
		});
		assert(!writes.join("").includes("raw-output"));
		assert(!writes.join("").includes("raw-error"));
		// The launcher's own color query is the only OSC on the terminal.
		assert(!writes.join("").replaceAll(TERMINAL_COLOR_QUERY, "").includes("\x1b]"));
		let exited = false;
		client.sandbox!.worker.once("exit", () => {
			exited = true;
		});
		source = `export default async()=>new Promise(()=>{})`;
		const reloading = client.reload();
		const rejected = assert.rejects(reloading, /closed/);
		await poll(() => bundleRequests === 2);
		// Give the downloaded module time to enter its stalled setup, not its ten-second startup timeout.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const first = client.close();
		const second = client.close();
		assert.equal(first, second);
		await second;
		await rejected;
		assert(exited);
		assert.equal(stopped, 1);
	},
);
