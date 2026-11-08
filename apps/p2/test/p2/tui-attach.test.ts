import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { FileSummaries } from "../../plugins/files/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { launcherActions, localPath, openLocalFile, uploadName } from "../../src/hosts/tui-actions.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { Grants, type LauncherAction, type LauncherActionContext } from "../../src/hosts/tui-grants.ts";
import { TrustedUi } from "../../src/hosts/tui-trusted-ui.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
const C = (action: LauncherAction | undefined) => {
	assert(action?.kind === "C");
	return action;
};
const K = (action: LauncherAction | undefined) => {
	assert(action?.kind === "K");
	return action;
};

function context(session: string | undefined, confirm: boolean, overrides: Partial<LauncherActionContext> = {}) {
	const shown: string[] = [];
	const ui = new TrustedUi({ write: () => {}, columns: 100, rows: 30 }, "http://server.test");
	ui.confirm = async (request) => {
		shown.push(JSON.stringify(request));
		return confirm;
	};
	ui.notice = async () => {};
	const value: LauncherActionContext & { shown: string[] } = {
		grant: new Grants("http://server.test").create(
			"attach",
			"C",
			{},
			session ? { session, conversation: 1 } : undefined,
		),
		ui,
		origin: new URL("http://server.test"),
		ask: async () => null,
		writeTerminal: () => {},
		sendInput: () => {},
		releaseTerminal: (run) => run(),
		shown,
		...overrides,
	};
	return value;
}

test("local files: paths as dropped, regular files only, no final symlinks, 25 MiB", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-attach-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	assert.equal(localPath("'/a b/c.png'"), "/a b/c.png");
	assert.equal(localPath("/a\\ b/c.png"), "/a b/c.png");
	assert.equal(localPath("file:///a%20b/c.png"), "/a b/c.png");
	assert.equal(localPath("~/x.txt"), join(homedir(), "x.txt"));
	assert.equal(localPath(""), undefined);
	const file = join(directory, "photo.PNG");
	writeFileSync(file, "png bytes");
	const opened = openLocalFile(file);
	assert.equal(opened.size, 9);
	assert.equal(opened.mimeType, "image/png");
	assert.throws(() => openLocalFile(directory), /regular file/);
	symlinkSync(file, join(directory, "link.png"));
	assert.throws(() => openLocalFile(join(directory, "link.png")), /ELOOP|symbolic/);
	execFileSync("mkfifo", [join(directory, "fifo")]);
	assert.throws(() => openLocalFile(join(directory, "fifo")), /regular file/);
	const big = join(directory, "big.bin");
	writeFileSync(big, "");
	truncateSync(big, 25 * 1024 * 1024 + 1);
	assert.throws(() => openLocalFile(big), /25 MiB/);
	assert.equal(uploadName("bad\x1bname/../x.txt"), "x.txt");
});

test("launcher file picker: browses this computer, chooses a file, Escape cancels", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-picker-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "sub"));
	writeFileSync(join(directory, "sub", "inner.txt"), "x");
	writeFileSync(join(directory, "top.txt"), "y");
	const written: string[] = [];
	const ui = new TrustedUi({ write: (data) => written.push(data), columns: 80, rows: 20 }, "http://server.test");
	const picked = ui.pick("Choose a file to upload", directory);
	assert(written.join("").includes("sub/") && written.join("").includes("top.txt"));
	ui.handleInput("\x1b[B");
	ui.handleInput("\r");
	assert(written.join("").includes("inner.txt"));
	for (const char of "inn") ui.handleInput(char);
	ui.handleInput("\x1b[B");
	ui.handleInput("\r");
	assert.equal(await picked, join(directory, "sub", "inner.txt"));
	const cancelled = ui.pick("Choose", directory);
	ui.handleInput("\x1b");
	assert.equal(await cancelled, undefined);
});

test("uploads: the bound session, fixed route and Origin, confirmation first, no redirects, cancellable", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-upload-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, "notes.txt");
	writeFileSync(file, "hello upload");
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
		{ cwd: fixture.workspace },
		BACKGROUND_CONTEXT,
	);
	const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
	const actions = launcherActions({ url, credentials: {}, role: "owner" });
	const attach = C(actions.attach);
	assert.equal(attach.consent({ path: file }, { origin: url, target: undefined }), undefined, "no session bound");
	assert.equal(
		attach.consent({ path: 5 }, { origin: url, target: { session: session.id, conversation: 1 } }),
		undefined,
	);
	const denied = context(session.id, false);
	assert.equal(await attach.run({ path: file }, denied), null);
	assert.match(denied.shown[0]!, /notes\.txt/);
	assert.match(denied.shown[0]!, /12 B/);
	assert.match(denied.shown[0]!, new RegExp(session.id));
	// The session's uploads, as the server mirrors them.
	const mirror = await holdIn(fixture.browser(), FileSummaries, {}, "owner");
	const uploads = async () => (await mirror.of({ session: session.id }, BACKGROUND_CONTEXT)).uploads;
	assert.equal(await uploads(), undefined, "nothing uploaded without confirmation");
	const uploaded = (await attach.run({ path: file }, context(session.id, true))) as { id: string; name: string };
	assert.equal(uploaded.name, "notes.txt");
	assert.deepEqual(
		(await uploads())?.newest.map(({ path, key }) => [path, key]),
		[[`${uploaded.id}-notes.txt`, uploaded.id]],
	);
	await assert.rejects(attach.run({ path: directory }, context(session.id, true)), /regular file/);

	// A redirecting or slow server: refused, and a cancelled grant aborts the upload.
	let mode: "redirect" | "slow" = "redirect";
	const origins: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		origins.push(request.headers.origin);
		if (mode === "redirect") {
			response.writeHead(307, { Location: "https://evil.test/upload" });
			response.end();
		} else request.resume();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const other = new URL(`http://127.0.0.1:${address.port}`);
	const remote = C(launcherActions({ url: other, credentials: {}, role: "owner" }).attach);
	await assert.rejects(remote.run({ path: file }, context(session.id, true)));
	assert.deepEqual(origins, [other.origin], "exact Origin");
	mode = "slow";
	const grants = new Grants("x");
	const grant = grants.create("attach", "C", {}, { session: session.id, conversation: 1 });
	const running = remote.run({ path: file }, context(session.id, true, { grant }));
	await poll(() => origins.length === 2);
	grants.cancel(grant.id);
	await assert.rejects(running, /abort|cancel/i);
});

test("Ctrl+V: an image uploads after confirmation; text is pasted as typed; files go through the facts", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
		{ cwd: fixture.workspace },
		BACKGROUND_CONTEXT,
	);
	const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	let clipboard: { image?: Uint8Array; text?: string } = { image: png };
	const paste = K(
		launcherActions({
			url,
			credentials: {},
			role: "owner",
			readClipboard: {
				files: async () => null,
				image: async () => (clipboard.image ? { bytes: clipboard.image, mimeType: "image/png" } : null),
				text: async () => clipboard.text ?? null,
			},
		})["paste.key"],
	);
	assert.equal(paste.key, "app.clipboard.pasteImage");
	const asked: [string, unknown][] = [];
	const ask = async (kind: string, payload?: unknown) => {
		asked.push([kind, payload]);
		return { added: true };
	};
	await paste.run(context(session.id, false, { ask }));
	assert.deepEqual(asked, [], "declined: nothing uploaded or attached");
	const confirmed = context(session.id, true, { ask });
	await paste.run(confirmed);
	assert.match(confirmed.shown[0]!, /image\/png, 11 B/);
	assert.equal(asked[0]?.[0], "attached");
	assert.match(JSON.stringify(asked[0]?.[1]), /clipboard-.*\.png/);
	clipboard = { text: "pasted\x1b]52;c;x\x07 text" };
	const inputs: string[] = [];
	await paste.run(context(session.id, true, { sendInput: (data) => inputs.push(data) }));
	assert.deepEqual(inputs, ["\x1b[200~pasted]52;c;x text\x1b[201~"]);
});

test(
	"real worker: /attach and Ctrl+V upload after y, chips show them, Backspace removes one, the next send carries them",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "p2-attach-e2e-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const file = join(directory, "report.txt");
		writeFileSync(file, "quarterly numbers");
		const fixture = await startFixture();
		t.after(() => fixture.close());
		await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
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
				readClipboard: {
					files: async () => null,
					image: async () => ({
						bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
						mimeType: "image/png",
					}),
					text: async () => null,
				},
			}),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => !(await screen()).includes("Connecting conversation") && (await screen()).includes("•"));
		for (const char of `/attach ${file}`) terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Show this local file for upload"));
		terminal.sendInput("y");
		await poll(async () => (await screen()).includes("Upload a local file to this session"));
		assert((await screen()).includes("17 B"));
		terminal.sendInput("y");
		await poll(async () => (await screen()).includes("[report.txt 17 B]"), 10000, "chip");
		for (const char of "summarize") terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Echo: summarize"), 20000);
		await poll(async () => !(await screen()).includes("[report.txt 17 B]"));
		// The message carried the upload (the server's input entry lists it).
		await poll(async () => (await screen()).includes("report.txt"));
		// Ctrl+V with an image: the launcher's confirmation, then a chip from the launcher's `attached` answer.
		terminal.sendInput("\x16");
		await poll(async () => (await screen()).includes("Upload the clipboard image to this session"));
		terminal.sendInput("y");
		await poll(async () => /\[clipboard-[^\]]+\.png 8 B\]/.test(await screen()), 10000, "image chip");
		// Backspace on the empty editor removes the last attachment.
		terminal.sendInput("\x7f");
		await poll(async () => !(await screen()).includes(".png 8 B]"));
	},
);
