import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Terminals } from "../../plugins/terminals/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame, type TerminalEvent } from "../../plugins/terminals/protocol.ts";
import terminalsServer from "../../plugins/terminals/server.ts";
import { startServer } from "../../src/hosts/server.ts";
import { Server } from "../../src/runtime/server.ts";
import { APP, clientHost, expectChord, holdIn, type LocalOwner, localOwner, poll, testHost } from "./helpers.ts";

let noDaemon: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	noDaemon = error instanceof Error ? error.message : "No pi-env daemon with terminal support";
}

test("terminals objects deny guests before acquiring a detached-host resource", async (t) => {
	const fixture = await testHost({
		facets: [terminalsServer],
		stubs: [
			[
				Server,
				(_input, _principal, self) => ({
					info: self.state({
						app: APP,
						dataDir: tmpdir(),
						port: 0,
						fake: true,
						allowedHosts: [],
					}),
					resourceOptions: {},
					revokeGuests: () => {},
					revokeOwners: () => {},
				}),
			],
		],
	});
	t.after(() => fixture.close());
	const guest = fixture.client({
		kind: "guest",
		id: "g",
		name: "Guest",
		home: "s",
		sessions: { s: "full" },
		revision: 1,
	});
	const view = guest.hold(Terminals, { session: "s", view: randomUUID() }, BACKGROUND_CONTEXT);
	await expectChord(whenLive(view), "forbidden");
});

async function byteChannel(owner: LocalOwner, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${owner.port}/terminal?${new URLSearchParams({ token })}`, {
		headers: { Cookie: owner.cookie },
	});
	const events: TerminalEvent[] = [];
	const output: Buffer[] = [];
	socket.on("message", (data, binary) => {
		if (binary) output.push(Buffer.from(data as Buffer));
		else events.push(JSON.parse(data.toString()) as TerminalEvent);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return { socket, events, output, text: () => Buffer.concat(output).toString("utf8") };
}

async function refused(port: number, query: string, headers: Record<string, string> = {}): Promise<number> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal${query}`, { headers });
	return new Promise((resolve, reject) => {
		socket.once("unexpected-response", (_request, response) => {
			response.resume();
			socket.terminate();
			resolve(response.statusCode ?? 0);
		});
		socket.once("open", () => {
			socket.terminate();
			reject(new Error("Unexpectedly admitted terminal channel"));
		});
		socket.on("error", () => {});
	});
}

test("terminal byte channels need an owner and a live one-use chord2 grant", { timeout: 30_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-terminal-auth-"));
	const server = await startServer({ dataDir: directory, port: 0, fake: true, web: false });
	const owner = await localOwner(server);
	const client = clientHost(owner);
	try {
		const sessions = await holdIn(client, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
		const view = client.hold(Terminals, { session: session.id, view: randomUUID() }, BACKGROUND_CONTEXT);
		await whenLive(view);
		assert.equal(await refused(server.port, "", { Cookie: owner.cookie }), 403);
		const { token } = await view.channel({}, BACKGROUND_CONTEXT);
		assert.equal(await refused(server.port, `?${new URLSearchParams({ token })}`), 403, "loopback alone is no owner");
		assert.equal(
			await refused(server.port, `?${new URLSearchParams({ token })}`, {
				Cookie: owner.cookie,
				Origin: "https://untrusted.invalid",
			}),
			403,
		);
		const bytes = await byteChannel(owner, token);
		await view.list({}, BACKGROUND_CONTEXT);
		await poll(() => bytes.events.some((event) => event.type === "list"));
		assert.deepEqual(
			bytes.events.find((event) => event.type === "list"),
			{ type: "list", terminals: [] },
		);
		assert.equal(await refused(server.port, `?${new URLSearchParams({ token })}`, { Cookie: owner.cookie }), 403);
		// Control JSON cannot be smuggled onto the dedicated byte channel.
		const closed = new Promise<void>((resolve) => bytes.socket.once("close", () => resolve()));
		bytes.socket.send(JSON.stringify({ type: "open", cwd: "/", sessionId: session.id, cols: 40, rows: 10 }));
		await closed;
	} finally {
		await client.close(BACKGROUND_CONTEXT);
		await server.close();
		const host = await connectTerminalHost(directory, APP);
		host.resume();
		host.write(encodeFrame({ type: "shutdown" }));
		await new Promise((resolve) => host.once("close", resolve));
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"terminals survive compatible reload and server restart; controls stay session-scoped",
	{ timeout: 60_000, skip: noDaemon },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-terminal-restart-"));
		const shell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		let server = await startServer({ dataDir: directory, port: 0, fake: true, web: false });
		let owner = await localOwner(server);
		let client = clientHost(owner);
		let bytes: Awaited<ReturnType<typeof byteChannel>> | undefined;
		try {
			const sessions = await holdIn(client, Sessions, {}, "owner");
			const session = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			const other = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			let view = client.hold(Terminals, { session: session.id, view: randomUUID() }, BACKGROUND_CONTEXT);
			bytes = await byteChannel(owner, (await view.channel({}, BACKGROUND_CONTEXT)).token);
			await view.theme({ foreground: 0xeeeeee, background: 0x111111, scheme: "dark" }, BACKGROUND_CONTEXT);
			await view.open({ cols: 80, rows: 10, conversation: 1 }, BACKGROUND_CONTEXT);
			await poll(() => bytes!.events.some((event) => event.type === "attached"));
			const opened = bytes.events.find((event) => event.type === "attached");
			assert(opened?.type === "attached");
			assert.equal(opened.terminal.cwd, directory);
			const id = opened.terminal.id;
			await poll(() => /[$#] $/.test(bytes!.text()));
			bytes.socket.send(Buffer.from("printf 'before-%s\\n' re''start\n"));
			await poll(() => bytes!.text().includes("before-restart"));
			const otherView = client.hold(Terminals, { session: other.id, view: randomUUID() }, BACKGROUND_CONTEXT);
			await expectChord(otherView.attach({ terminalId: id }, BACKGROUND_CONTEXT), "forbidden");
			await server.reload(["terminals"]);
			await view.resize({ cols: 70, rows: 12 }, BACKGROUND_CONTEXT);
			await client.close(BACKGROUND_CONTEXT);
			await server.close();
			server = await startServer({ dataDir: directory, port: 0, fake: true, web: false });
			owner = await localOwner(server);
			client = clientHost(owner);
			view = client.hold(Terminals, { session: session.id, view: randomUUID() }, BACKGROUND_CONTEXT);
			bytes = await byteChannel(owner, (await view.channel({}, BACKGROUND_CONTEXT)).token);
			await view.attach({ terminalId: id }, BACKGROUND_CONTEXT);
			await poll(() => bytes!.text().includes("before-restart"));
			bytes.socket.send(Buffer.from("stty size; echo after-re''start\n"));
			await poll(() => bytes!.text().includes("12 70") && bytes!.text().includes("after-restart"));
			await view.close({ force: true }, BACKGROUND_CONTEXT);
			await poll(() => bytes!.events.some((event) => event.type === "closed"));
		} finally {
			bytes?.socket.terminate();
			await client.close(BACKGROUND_CONTEXT);
			await server.close();
			const host = await connectTerminalHost(directory, APP);
			host.resume();
			host.write(encodeFrame({ type: "shutdown" }));
			await new Promise((resolve) => host.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
