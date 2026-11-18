// Machines running `pi-env agent`, reached through Radius (envs.json type `radius`): configuration, the client channel
// to the machine with the fake relay (radius-fixture.ts) and a stand-in machine serving a real `pi-env serve`
// (radius-machine.ts), the Envs sheet's machines and enrollment, sessions whose tools, workspace, terminal and MCP
// servers run there, and the ports tool keeping forwards on the machine.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { envRevision, parseEnvs, validateEnv } from "../../plugins/envs/config.ts";
import { connectionRevision } from "../../plugins/envs/connection-revision.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import { remoteSession } from "../../plugins/envs/remote-env.ts";
import { Mcp } from "../../plugins/mcp/contract.ts";
import { Ports } from "../../plugins/ports/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Terminals } from "../../plugins/terminals/contract.ts";
import type { TerminalEvent } from "../../plugins/terminals/protocol.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import { writeRadiusConfig } from "../../src/runtime/radius-config.ts";
import { holdIn, poll, startFixture, until } from "./helpers.ts";
import { fakeRadius } from "./radius-fixture.ts";
import { fakeMachine } from "./radius-machine.ts";

/** The daemon the stand-in machine serves channels with: `PI_ENV_DAEMON`, else the debug build of packages/env. */
const DAEMON =
	process.env.PI_ENV_DAEMON ??
	fileURLToPath(new URL("../../../../packages/env/daemon/target/debug/pi-env", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const SERVER = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";

const results = (view: ConversationView | null | undefined, tool: string): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool,
		),
	);
const text = (result: ToolResultMessage | undefined) =>
	(result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

test("a Radius machine's configuration: its server ID, shell settings, revisions; sessions are lazy", () => {
	const config = { type: "radius" as const, server: SERVER, shellEnv: { B: "2", A: "1" } };
	assert.deepEqual(parseEnvs(JSON.stringify({ hand: config })), { hand: config });
	for (const server of ["", "6F1C2A9E-3B4D-4E5F-8A7B-9C0D1E2F3A4B", "not-a-uuid", `${SERVER}x`])
		assert.throws(() => validateEnv({ type: "radius", server }), /configuration/);
	assert.throws(() => validateEnv({ type: "radius", server: SERVER, host: "box" }), /configuration/);
	assert.equal(envRevision(config), envRevision({ ...config, shellEnv: { A: "1", B: "2" } }));
	assert.equal(connectionRevision({ hand: config }, config), envRevision(config));
	// A sandbox needs an SSH host: a Radius machine is not one.
	assert.throws(
		() => parseEnvs(JSON.stringify({ hand: config, box: { type: "gondolin", host: "hand" } })),
		/not an SSH environment/,
	);
	const session = remoteSession("/nonexistent", "hand", config, "/work");
	assert.equal(session.env.cwd, "/work", "constructing a session on a machine never connects");
	session.connection.close();
});

test(
	"a session on a Radius machine runs its tools, workspace, terminal, MCP servers and forwards there",
	{
		timeout: 180_000,
		skip: existsSync(DAEMON) ? false : `no pi-env daemon at ${DAEMON} (npm run build:daemon in packages/env)`,
	},
	async (t) => {
		// The brain stays off: the machine is reached with the owner's sign-in alone.
		process.env.P2_RADIUS = "0";
		t.after(() => delete process.env.P2_RADIUS);
		const radius = await fakeRadius({ channels: true });
		t.after(() => radius.close());
		const token = radius.addMachine(SERVER, "Laptop");
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const p2 = randomUUID();
		const owner = fixture.browser();
		const envs = await holdIn(owner, Envs, {}, "owner");
		// Not signed in to Radius: no machines, and an environment there refuses instead of running here.
		await assert.rejects(envs.machines({}, BACKGROUND_CONTEXT), /not signed in to Radius/);
		await writeRadiusConfig(fixture.dataDir, {
			gateway: radius.gateway,
			serverId: p2,
			credential: { type: "oauth", access: "fixture-token", refresh: "unused", expires: Date.now() + 3_600_000 },
		});
		assert.deepEqual(await envs.machines({}, BACKGROUND_CONTEXT), [
			{ server: SERVER, name: "Laptop", status: "offline", lastSeenAt: new Date(0).toISOString() },
		]);
		const enrollment = await envs.enroll({ name: "laptop" }, BACKGROUND_CONTEXT);
		assert.equal(enrollment.code, "CODE-1");
		assert.match(enrollment.install.sh, /--code CODE-1$/);
		assert.deepEqual(radius.enrollments, [{ name: "laptop" }]);

		await envs.save({ name: "hand", config: { type: "radius", server: SERVER } }, BACKGROUND_CONTEXT);
		const offline = await envs.test({ name: "hand" }, BACKGROUND_CONTEXT);
		assert(!offline.ok);
		assert.match(offline.error, /Machine "hand" is not connected to Radius/);

		const machine = await fakeMachine({ gateway: radius.gateway, serverId: SERVER, token, daemon: DAEMON });
		t.after(() => machine.close());
		await radius.machine(SERVER);
		const tested = await envs.test({ name: "hand" }, BACKGROUND_CONTEXT);
		assert(tested.ok, tested.ok ? "" : tested.error);
		assert.equal(tested.home, homedir());
		assert.equal((await envs.listDirectory({ env: "hand", path: "~" }, BACKGROUND_CONTEXT)).path, homedir());

		// MCP servers of the owner's mcp.json follow sessions to the machine.
		await writeFile(
			join(fixture.dataDir, "mcp.json"),
			JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [FIXTURE] } } }),
		);
		const cwd = join(fixture.workspace, "on-hand");
		await mkdir(cwd);
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ env: "hand", cwd, title: "On the hand" }, BACKGROUND_CONTEXT);
		assert.equal(session.env, "hand");
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "write", requestId: "hand-write" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => results(view, "write").length > 0, 60_000);
		assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "before\n");
		await chat.send({ text: "bash", requestId: "hand-bash" }, BACKGROUND_CONTEXT);
		const ran = await until(chat.view, (view) => results(view, "bash").length > 0, 60_000);
		assert.equal(text(results(ran, "bash")[0]).trim(), await realpath(cwd));
		const workspace = owner.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const file = await workspace.query({ kind: "file", path: "created.txt" }, BACKGROUND_CONTEXT);
		assert(file.kind === "file" && file.text === "before\n");
		workspace.release();
		const mcp = await holdIn(owner, Mcp, {}, "owner");
		const instances = await until(
			mcp.instances,
			(list) =>
				list?.some(
					(instance) =>
						instance.server === "files" && instance.location?.env === "hand" && instance.status === "connected",
				) ?? false,
			60_000,
		);
		assert.deepEqual(instances.find((instance) => instance.location?.env === "hand")?.runsOn, { env: "hand" });
		mcp.release();

		// A terminal of the session opens on the machine.
		const terminals = owner.hold(Terminals, { session: session.id, view: randomUUID() }, BACKGROUND_CONTEXT);
		const { token: grant } = await terminals.channel({}, BACKGROUND_CONTEXT);
		const socket = new WebSocket(
			`ws://127.0.0.1:${fixture.server.port}/terminal?${new URLSearchParams({ token: grant })}`,
			{
				headers: { Cookie: fixture.owner.cookie },
			},
		);
		const events: TerminalEvent[] = [];
		const output: Buffer[] = [];
		socket.on("message", (bytes, binary) => {
			if (binary) output.push(Buffer.from(bytes as Buffer));
			else events.push(JSON.parse(bytes.toString()) as TerminalEvent);
		});
		socket.on("error", () => {});
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
			await terminals.open({ cols: 60, rows: 12, conversation: 1 }, BACKGROUND_CONTEXT);
			await poll(() => events.some((event) => event.type === "attached" || event.type === "error"), 30_000);
			const attached = events.find((event) => event.type === "attached");
			assert(attached?.type === "attached", JSON.stringify(events));
			assert.equal(attached.terminal.env, "hand");
			socket.send(Buffer.from("printf 'HAND_TERMINAL_%s\\n' sentinel\r"));
			await poll(() => Buffer.concat(output).toString("utf8").includes("HAND_TERMINAL_sentinel"), 30_000);
			await terminals.close({ force: true }, BACKGROUND_CONTEXT);
		} finally {
			socket.close();
			await terminals.restartHost({}, BACKGROUND_CONTEXT).catch(() => {});
			terminals.release();
		}

		// The ports tool keeps the session's forwards on the machine, tagged with this server and the session.
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		let serial = 0;
		const call = async (query: object) => {
			await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0, 60_000);
			const count = results(chat.view.value, "ports").length;
			await chat.send(
				{ text: `ports ${JSON.stringify(query)}`, requestId: `hand-ports-${++serial}` },
				BACKGROUND_CONTEXT,
			);
			return results(await until(chat.view, (view) => results(view, "ports").length > count, 60_000), "ports").at(
				-1,
			)!;
		};
		const opened = await call({ action: "open", port: 5173, name: "web" });
		assert.equal(opened.isError, false, text(opened));
		assert.match(
			text(opened),
			/Forwarded port 5173, private: https:\/\/fwd--0123456789abcdef0123456789abcdef--[0-9a-f]+\.rdtun\.com\//,
		);
		assert.deepEqual(
			machine.forwards.map((forward) => [forward.port, forward.name, forward.tag]),
			[[5173, "web", { p2, session: session.id }]],
		);
		assert.equal((await call({ action: "open", port: 5173, public: true })).isError, false);
		assert.equal(machine.forwards.length, 1, "opening a forwarded port again updates it");
		assert.equal(machine.forwards[0]?.public, true);
		// The owner sees and changes the machine's forwards in the Ports sheet.
		const ports = await holdIn(owner, Ports, {}, "owner");
		const listed = await ports.machine({ env: "hand" }, BACKGROUND_CONTEXT);
		assert.equal(listed.forwards[0]?.sessionTitle, "On the hand");
		assert.match(listed.forwards[0]?.publicUrl ?? "", /^https:\/\/pub--/);
		await ports.machineAdd({ env: "hand", port: 8080 }, BACKGROUND_CONTEXT);
		const added = machine.forwards.find((forward) => forward.port === 8080)!;
		assert.equal(added.tag, undefined);
		await ports.machineSetPublic({ env: "hand", id: added.id, public: true }, BACKGROUND_CONTEXT);
		assert.equal(machine.forwards.find((forward) => forward.port === 8080)?.public, true);
		await ports.machineRemove({ env: "hand", id: added.id }, BACKGROUND_CONTEXT);
		assert(!machine.forwards.some((forward) => forward.port === 8080));
		await call({ action: "open", port: 3000 });
		assert.match(text(await call({ action: "close", port: 3000 })), /Stopped forwarding port 3000/);
		ports.release();
		// Archiving the session closes its forwards on the machine.
		chat.release();
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		await poll(() => machine.forwards.length === 0, 30_000);
		status.release();

		// The machine going offline fails what needs it, and never runs anything here instead.
		machine.close();
		await poll(async () => !(await envs.test({ name: "hand" }, BACKGROUND_CONTEXT)).ok, 30_000);
	},
);
