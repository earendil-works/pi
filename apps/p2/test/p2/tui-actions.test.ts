import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocketServer } from "ws";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { editorArgv, launcherActions, originPath, safeFileName } from "../../src/hosts/tui-actions.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { Grants, type LauncherAction, type LauncherActionContext } from "../../src/hosts/tui-grants.ts";
import { TrustedUi } from "../../src/hosts/tui-trusted-ui.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const FILE = "aaaaaaaa-2222-4333-8444-555555555555";
const target = { session: SESSION, conversation: 1 };
const origin = new URL("https://server.test");

function context(overrides: Partial<LauncherActionContext> = {}): LauncherActionContext & { notices: string[] } {
	const notices: string[] = [];
	const ui = new TrustedUi({ write: () => {}, columns: 80, rows: 24 }, origin.origin);
	ui.notice = async (text: string) => {
		notices.push(text);
	};
	return {
		grant: new Grants(origin.origin).create("test", "C", {}, target),
		ui,
		origin,
		ask: async () => null,
		writeTerminal: () => {},
		sendInput: () => {},
		releaseTerminal: (run) => run(),
		notices,
		...overrides,
	};
}
const C = (action: LauncherAction | undefined) => {
	assert(action?.kind === "C");
	return action;
};
const K = (action: LauncherAction | undefined) => {
	assert(action?.kind === "K");
	return action;
};

test("copy: C shows the full text and writes only on run; K asks the worker, then says what it copied", async () => {
	const copies: string[] = [];
	const actions = launcherActions({
		url: origin,
		credentials: {},
		role: "guest",
		clipboard: async (text) => {
			copies.push(text);
		},
	});
	const copy = C(actions.copy);
	for (const payload of [undefined, {}, { text: "" }, { text: 5 }, { text: "x".repeat(1024 * 1024 + 1) }])
		assert.equal(copy.consent(payload, { origin, target }), undefined, JSON.stringify(payload)?.slice(0, 40));
	const consent = copy.consent({ text: "line one\nline two", label: "the last answer" }, { origin, target });
	assert.equal(consent?.action, "Copy 17 characters to the clipboard");
	assert.equal(consent?.preview, "line one\nline two");
	assert.deepEqual(consent?.facts, [["What", "the last answer (server-reported)"]]);
	assert.deepEqual(copies, [], "nothing is written before confirmation");
	const ctx = context();
	await copy.run({ text: "line one\nline two" }, ctx);
	assert.deepEqual(copies, ["line one\nline two"]);
	assert.deepEqual(ctx.notices, ["Copied 17 characters: line one"]);

	const key = K(actions["copy.key"]);
	assert.equal(key.key, "app.message.copy");
	const asked: string[] = [];
	await key.run(
		context({
			ask: async (kind) => {
				asked.push(kind);
				return { text: "answer" };
			},
		}),
	);
	assert.deepEqual(asked, ["copyText"]);
	assert.deepEqual(copies.at(-1), "answer");
	const empty = context({ ask: async () => ({ text: "" }) });
	await key.run(empty);
	assert.deepEqual(empty.notices, ["Nothing to copy"]);
	assert.equal(copies.length, 2);
});

test("openUrl: https externals and allowlisted origin paths only, never with credentials", async () => {
	const opened: string[] = [];
	const actions = launcherActions({
		url: origin,
		credentials: { cookie: "owner=secret" },
		role: "owner",
		openBrowser: (url) => opened.push(url),
	});
	const open = C(actions.openUrl);
	const ok = (payload: unknown) => open.consent(payload, { origin, target }) !== undefined;
	assert(ok({ kind: "external", url: "https://provider.test/oauth?x=1" }));
	for (const url of ["http://provider.test", "https://user:pass@provider.test", "javascript:alert(1)", "file:///etc"])
		assert(!ok({ kind: "external", url }), url);
	assert(ok({ kind: "origin", path: `/s/${OTHER}` }));
	assert(ok({ kind: "origin", path: `/artifact?session=${SESSION}&name=chart&version=2` }));
	assert(ok({ kind: "origin", path: `/download?session=${SESSION}&id=${FILE}` }));
	for (const path of [
		`/artifact?session=${OTHER}&name=chart&version=2`,
		`/download?session=${SESSION}&id=${FILE}&cookie=1`,
		"/owner",
		"/__p2_dev",
		"//evil.test/s/x",
		"https://evil.test/",
		`/s/${SESSION}#x`,
		"/s/../owner",
	])
		assert(!ok({ kind: "origin", path }), path);
	const consent = open.consent({ kind: "origin", path: `/s/${SESSION}` }, { origin, target });
	assert.equal(consent?.preview, `https://server.test/s/${SESSION}`);
	assert.match(String(consent?.facts?.[0]?.[1]), /own sign-in/);
	await open.run({ kind: "origin", path: `/s/${SESSION}` }, context());
	await open.run({ kind: "external", url: "https://provider.test/oauth?x=1" }, context());
	assert.deepEqual(opened, [`https://server.test/s/${SESSION}`, "https://provider.test/oauth?x=1"]);
	assert(!opened.join("").includes("secret"));
	assert.equal(originPath(origin, `/s/${SESSION}`)?.origin, origin.origin);
});

test("download: fixed route, the launcher's cookie, bounded, sanitized, never overwrites, no redirects", async (t) => {
	const folder = mkdtempSync(join(tmpdir(), "p2-downloads-"));
	t.after(() => rmSync(folder, { recursive: true, force: true }));
	const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
	let mode: "file" | "huge" | "redirect" = "file";
	const server = createServer((request, response) => {
		seen.push({ url: request.url ?? "", headers: request.headers });
		if (mode === "redirect") {
			response.writeHead(302, { Location: "https://evil.test/" });
			response.end();
		} else if (mode === "huge") {
			response.writeHead(200);
			const chunk = Buffer.alloc(1024 * 1024);
			let sent = 0;
			const write = () => {
				while (sent < 30 && response.write(chunk)) sent++;
				if (sent < 30) response.once("drain", write);
				else response.end();
			};
			write();
		} else {
			response.writeHead(200, {
				"Content-Disposition": `attachment; filename="x"; filename*=UTF-8''${encodeURIComponent("../../.evil\x1b.txt")}`,
			});
			response.end("content");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address === "object");
	const url = new URL(`http://127.0.0.1:${address.port}`);
	const actions = launcherActions({
		url,
		credentials: { cookie: "p2_guest_1=a.b" },
		role: "guest",
		downloads: folder,
	});
	const download = C(actions.download);
	assert.equal(download.consent({ kind: "file", session: OTHER, id: FILE }, { origin: url, target }), undefined);
	assert.equal(download.consent({ kind: "file", session: SESSION, id: "../x" }, { origin: url, target }), undefined);
	const consent = download.consent(
		{ kind: "file", session: SESSION, id: FILE, name: "report.pdf" },
		{ origin: url, target },
	);
	assert.deepEqual(consent?.facts?.[0], ["File", "report.pdf (server-reported)"]);
	assert.deepEqual(consent?.facts?.[1], ["Folder", folder]);
	const payload = { kind: "file", session: SESSION, id: FILE };
	assert.deepEqual(await download.run(payload, context()), { saved: true });
	assert.deepEqual(await download.run(payload, context()), { saved: true });
	assert.deepEqual(readdirSync(folder).sort(), ["evil_ (1).txt", "evil_.txt"]);
	assert.equal(readFileSync(join(folder, "evil_.txt"), "utf8"), "content");
	assert.equal(seen[0]!.url, `/download?session=${SESSION}&id=${FILE}`);
	assert.equal(seen[0]!.headers.cookie, "p2_guest_1=a.b");
	assert.equal(seen[0]!.headers.origin, url.origin);
	mode = "huge";
	await assert.rejects(download.run(payload, context()), /25 MiB/);
	mode = "redirect";
	await assert.rejects(download.run(payload, context()));
	assert.equal(readdirSync(folder).length, 2, "failed downloads leave nothing behind");
	const artifact = { kind: "artifact", session: SESSION, name: "chart", version: 3 };
	assert(download.consent(artifact, { origin: url, target }));
	assert.equal(download.consent({ ...artifact, name: "../x" }, { origin: url, target }), undefined);
	assert.equal(safeFileName("..\\..\\secret"), "secret");
	assert.equal(safeFileName(""), "download");
});

test("external editor and suspend lend the terminal; devCommand and signOut are owner actions on fixed routes", async (t) => {
	const editorCalls: string[][] = [];
	const lent: string[] = [];
	const actions = launcherActions({
		url: origin,
		credentials: { cookie: "owner=c" },
		role: "owner",
		editor: editorArgv(`code --wait "--flag with space"`),
		runEditor: async (argv, file) => {
			editorCalls.push([...argv]);
			writeFileSync(file, `${readFileSync(file, "utf8")} edited\n`);
			return 0;
		},
		suspendProcess: async () => {
			lent.push("suspended");
		},
	});
	const editor = K(actions["editor.external"]);
	assert.equal(editor.key, "app.editor.external");
	const asks: [string, unknown][] = [];
	const ctx = context({
		ask: async (kind, payload) => {
			asks.push([kind, payload]);
			return kind === "editorText" ? { text: "draft" } : { applied: true };
		},
		releaseTerminal: async (run) => {
			lent.push("released");
			try {
				return await run();
			} finally {
				lent.push("restored");
			}
		},
	});
	await editor.run(ctx);
	assert.deepEqual(editorCalls[0]?.slice(0, 3), ["code", "--wait", "--flag with space"]);
	assert.deepEqual(asks, [
		["editorText", undefined],
		["editorResult", { text: "draft edited" }],
	]);
	assert.deepEqual(lent, ["released", "restored"]);
	await K(actions.suspend).run(ctx);
	assert.deepEqual(lent.slice(2), ["released", "suspended", "restored"]);
	const windows = context();
	await K(launcherActions({ url: origin, credentials: {}, role: "owner", platform: "win32" }).suspend).run(windows);
	assert.match(windows.notices[0]!, /not supported on Windows/);

	const requests: { path: string; method: string; origin: string | null; cookie: string | null; body: string }[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const headers = new Headers(init?.headers);
			assert.equal(init?.redirect, "error");
			requests.push({
				path: new URL(String(input)).pathname,
				method: init?.method ?? "GET",
				origin: headers.get("origin"),
				cookie: headers.get("cookie"),
				body: String(init?.body ?? ""),
			});
			return Response.json({ ok: true, message: "Reloaded: chat" });
		},
	);
	const dev = C(actions.devCommand);
	assert(dev.consent({ action: "reload" }, { origin, target }));
	assert.equal(dev.consent({ action: "restart" }, { origin, target }), undefined);
	assert.equal(dev.consent({ action: "reload", plugins: ["x"] }, { origin, target }), undefined);
	assert.deepEqual(await dev.run({ action: "reload" }, context()), { message: "Reloaded: chat" });
	const signOut = C(actions.signOut);
	assert.match(signOut.consent({ all: true }, { origin, target })?.action ?? "", /ALL owner devices/);
	await signOut.run({ all: false }, context());
	assert.deepEqual(
		requests.map(({ path, method, origin, cookie }) => [path, method, origin, cookie]),
		[
			["/__p2_dev", "POST", "https://server.test", "owner=c"],
			["/owner/logout", "POST", "https://server.test", "owner=c"],
		],
	);
	assert.equal(requests[0]!.body, '{"action":"reload"}');
	const guest = launcherActions({ url: origin, credentials: { cookie: "g" }, role: "guest" });
	assert.equal(C(guest.devCommand).consent({ action: "reload" }, { origin, target }), undefined);
	assert.equal(C(guest.signOut).consent({ all: true }, { origin, target }), undefined);
	const loopback = launcherActions({ url: new URL("http://127.0.0.1:1"), credentials: {}, role: "owner" });
	assert.equal(
		C(loopback.signOut).consent({ all: false }, { origin, target }),
		undefined,
		"the device owner has no cookie",
	);
	assert(C(loopback.signOut).consent({ all: true }, { origin, target }));
});

/** A fake worker that answers grant questions and reports navigation on demand. */
const FAKE_WORKER = `const seen=[];export default ({send,onMessage})=>onMessage(message=>{
	if(message.kind==='snapshot')return seen;
	if(message.kind!=='resize')seen.push(message);
	if(message.kind==='grantRequest'){
		if(message.ask==='copyText')return {text:'the answer'};
		if(message.ask==='editorText')return {text:'draft'};
		return {applied:true};
	}
	if(message.kind==='activate'){send({kind:'navigation',session:'s1',conversation:1});send({kind:'output',data:'\\x1b[?1049h\\x1b[?7lREADY'});}
	if(message.kind!=='input')return;
	if(message.data==='r')send({kind:'request',id:seen.length,action:'copy',payload:{text:'requested text'}});
	if(message.data==='2')send({kind:'navigation',session:'s2',conversation:1});
});`;

test(
	"launcher: the clipboard is written only after the copy key or a confirmation; the editor result is dropped after navigation; suspend resets modes",
	{ skip: !supported, timeout: 30000 },
	async (t) => {
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
		let stops = 0;
		const stop = terminal.stop.bind(terminal);
		terminal.stop = () => {
			stops++;
			stop();
		};
		const copies: string[] = [];
		let editing: (() => void) | undefined;
		let suspended: (() => void) | undefined;
		const actions = launcherActions({
			url,
			credentials: {},
			role: "owner",
			clipboard: async (text) => {
				copies.push(text);
			},
			editor: ["fake-editor"],
			runEditor: () =>
				new Promise((resolve) => {
					editing = () => resolve(0);
				}),
			suspendProcess: () =>
				new Promise((resolve) => {
					suspended = resolve;
				}),
		});
		const client = await startTuiClient({ terminal, url, pollMs: 60000, colorQueryMs: 10, actions });
		t.after(() => client.close());
		type Seen = { kind: string; ask?: string; data?: string; error?: string; ok?: boolean }[];
		const seen = async () => (await client.snapshot()) as Seen;
		await poll(() => writes.join("").includes("READY"));
		for (const key of ["a", "\r", "\x1b", "\x03", "\x16", "c", "y"]) terminal.sendInput(key);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(copies, [], "unrelated keys never write the clipboard");
		terminal.sendInput("\x18");
		await poll(() => copies.length === 1);
		assert.equal(copies[0], "the answer");
		await poll(async () => (await seen()).at(-1)?.kind === "redraw", 5000, "redraw after the summary");
		terminal.sendInput("r");
		await poll(() => writes.join("").includes("requested text"));
		assert.equal(copies.length, 1);
		terminal.sendInput("\x1b");
		await poll(async () =>
			(await seen()).some((message) => message.kind === "response" && message.error === "denied"),
		);
		assert.equal(copies.length, 1, "denied: nothing copied");
		terminal.sendInput("r");
		await poll(() => writes.filter((data) => data.includes("requested text")).length >= 2);
		terminal.sendInput("y");
		await poll(() => copies.length === 2);

		// External editor: worker IO suspended, terminal lent; navigating meanwhile drops the result.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		writes.length = 0;
		terminal.sendInput("\x07");
		await poll(() => editing !== undefined);
		assert.equal(stops, 1);
		assert(writes.join("").includes("\x1b[?7h") && writes.join("").includes("\x1b[?1049l"));
		client.sandbox!.post({ kind: "input", data: "2" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		editing!();
		await poll(async () => (await seen()).at(-1)?.kind === "redraw");
		assert(!(await seen()).some((message) => message.ask === "editorResult"), "dropped after navigation");
		assert(writes.join("").includes("\x1b[?1049h\x1b[?7l"), "the worker's modes are restored");

		// Suspend: modes undone and the terminal stopped before SIGTSTP; restored on SIGCONT.
		writes.length = 0;
		terminal.sendInput("\x1a");
		await poll(() => suspended !== undefined);
		assert.equal(stops, 2);
		assert(writes.join("").includes("\x1b[?7h\x1b[?1000l"));
		suspended!();
		await poll(() => writes.join("").includes("\x1b[?1049h"));
	},
);

test(
	"real worker: Ctrl+X copies the last answer, /copy asks first, Ctrl+G edits the draft in the external editor",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const copies: string[] = [];
		const terminal = new VirtualTerminal(100, 30);
		const client = await startTuiClient({
			terminal,
			url,
			pollMs: 60000,
			colorQueryMs: 10,
			actions: launcherActions({
				url,
				credentials: {},
				role: "owner",
				clipboard: async (text) => {
					copies.push(text);
				},
				editor: ["fake-editor"],
				runEditor: async (_argv, file) => {
					writeFileSync(file, `${readFileSync(file, "utf8")} edited`);
					return 0;
				},
			}),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		type Snapshot = { session?: string; drafts: [string, string][] };
		const draft = async () => {
			const { session, drafts } = (await client.snapshot()) as Snapshot;
			return drafts.find(([id]) => id === `${session}#1`)?.[1];
		};
		await poll(async () => (await screen()).includes("New session"), 15000);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => !(await screen()).includes("Connecting conversation") && (await screen()).includes("•"));
		for (const char of "hello") terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Echo: hello"), 20000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		terminal.sendInput("\x18");
		await poll(() => copies.length === 1);
		assert.equal(copies[0], "Echo: hello");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		for (const char of "/copy") terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Copy 11 characters to the clipboard"));
		assert.equal(copies.length, 1);
		terminal.sendInput("y");
		await poll(() => copies.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		for (const char of "draft") terminal.sendInput(char);
		await poll(async () => (await draft()) === "draft");
		terminal.sendInput("\x07");
		await poll(async () => (await draft()) === "draft edited");
		await poll(async () => (await screen()).includes("draft edited"));
	},
);
