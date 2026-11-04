import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT, statusOf, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { envId, envRevision, loadEnvs, parseEnvs, saveEnv, validateEnv } from "../../plugins/envs/config.ts";
import { Envs, environmentPath } from "../../plugins/envs/contract.ts";
import { remoteSession, sshOptions } from "../../plugins/envs/remote-env.ts";
import { EnvStore } from "../../plugins/envs/store.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { Terminals } from "../../plugins/terminals/contract.ts";
import { terminalDaemon } from "../../plugins/terminals/daemon.ts";
import type { TerminalEvent } from "../../plugins/terminals/protocol.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { expectChord, failureOf, holdIn, http, poll, startFixture, until } from "./helpers.ts";

const config = { type: "ssh" as const, host: "box" };
function which(program: string): string | undefined {
	try {
		return (
			execFileSync("sh", ["-c", `command -v ${program}`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}
const sshd =
	process.platform === "win32"
		? undefined
		: (which("sshd") ?? (existsSync("/usr/sbin/sshd") ? "/usr/sbin/sshd" : undefined));
let noTerminal: string | undefined;
try {
	await terminalDaemon(process.platform, process.arch, true);
} catch (error) {
	noTerminal = error instanceof Error ? error.message : "No pi-env daemon with terminal support";
}
function answered(view: ConversationView | null | undefined, text: string): boolean {
	return (
		view?.entries.some(
			(entry) =>
				entry.kind === "pi.assistant" &&
				entry.model?.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason === "stop" &&
						message.content.some((part) => part.type === "text" && part.text.includes(text)),
				),
		) ?? false
	);
}
function results(view: ConversationView | null | undefined, tool: string): string[] {
	return (view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			message.role === "toolResult" && message.toolName === tool
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		),
	);
}

test("env configuration validates SSH fields, revisions are canonical, sessions are lazy", async () => {
	assert.deepEqual(parseEnvs('\ufeff{ // environment\n "gpu": { "type": "ssh", "host": "box", }, }'), { gpu: config });
	for (const host of ["-oProxyCommand=id", "a b", "a\nb"])
		assert.throws(() => validateEnv({ ...config, host }), /host or user/);
	assert.throws(() => validateEnv({ ...config, port: 0 }), /configuration/);
	assert.throws(() => validateEnv({ ...config, password: "not-supported" }), /configuration/);
	assert.throws(() => validateEnv({ ...config, identityFile: 'a"b' }), /identity/);
	assert.throws(() => parseEnvs('{"GPU": {"type":"ssh","host":"box"}}'), /name/);
	const first = { ...config, shellEnv: { B: "2", A: "1" } };
	const second = { shellEnv: { A: "1", B: "2" }, ...config };
	assert.equal(envRevision(first), envRevision(second));
	assert.notEqual(envId("gpu", first), envId("gpu", config));
	const directory = mkdtempSync(join(tmpdir(), "p2-env-config-"));
	try {
		const session = remoteSession(directory, "gpu", config, "/project");
		assert.equal(session.remote(), undefined, "constructing a remote session never connects");
		assert.equal(session.env.cwd, "/project");
		assert.equal(sshOptions(directory, "gpu", config).hostKeyAlias, "pi-env-gpu");
		session.connection.close();
		await Promise.all([saveEnv(directory, "one", config), saveEnv(directory, "two", config)]);
		assert.deepEqual(Object.keys(await loadEnvs(directory)).sort(), ["one", "two"]);
		assert.equal((await stat(join(directory, "envs.json"))).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	assert.equal(environmentPath("gpu", "/project"), "gpu:/project");
});

test(
	"envs are owner-only, observed, retain valid config, browse local folders and refuse missing remote workers",
	{ timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const browser = fixture.browser();
		const envs = browser.hold(Envs, {}, BACKGROUND_CONTEXT);
		await envs.save({ name: "gpu", config }, BACKGROUND_CONTEXT);
		await until(envs.envs, (entries) => entries?.[0]?.name === "gpu");
		await writeFile(join(fixture.dataDir, "envs.json"), JSON.stringify({ gpu: { ...config, host: "changed" } }));
		await until(envs.envs, (entries) => entries?.[0]?.config.host === "changed");
		await writeFile(join(fixture.dataDir, "envs.json"), "{");
		await until(envs.failure, (error) => Boolean(error));
		assert.equal((await envs.listDirectory({ path: fixture.workspace }, BACKGROUND_CONTEXT)).path, fixture.workspace);
		assert.equal(
			(await until(envs.envs, (entries) => entries?.[0]?.config.host === "changed"))?.[0]?.config.host,
			"changed",
		);
		await writeFile(join(fixture.dataDir, "envs.json"), "{}");
		await until(envs.failure, (error) => error === null);
		const guest = fixture
			.as({
				kind: "guest",
				id: "guest",
				name: "Unverified",
				home: "unknown",
				sessions: { unknown: "full" },
				revision: 1,
			})
			.hold(Envs, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(guest), "forbidden");
		guest.release();
		// Remote owners manage keys too (Pi Mobile's rule): generate, then read the public key back.
		const tunnelOwner = fixture.as({ kind: "owner", access: "relay" }).hold(Envs, {}, BACKGROUND_CONTEXT);
		const generated = await tunnelOwner.generateKey({ name: "remote-key" }, BACKGROUND_CONTEXT);
		assert.match(generated.publicKey, /^ssh-ed25519 /);
		assert.equal(await tunnelOwner.publicKey({ name: "remote-key" }, BACKGROUND_CONTEXT), generated.publicKey);
		tunnelOwner.release();
		assert.equal(existsSync(join(fixture.dataDir, "ssh", "keys", "remote-key")), true);
		const session = await fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(Catalog, {})).create(
					{
						env: "missing",
						cwd: fixture.workspace,
						title: "Missing remote",
						model: { provider: "faux", modelId: "faux-1" },
						thinkingLevel: "high",
					},
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
		// The conversation never starts, so nothing can be sent to run locally instead.
		const chat = browser.hold(Chat, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		// A failed start leaves its holders waiting (failed until Retry).
		assert.match(
			(await failureOf(chat)).message,
			/not configured|refusing local|unavailable|exited|failed to start/i,
		);
		chat.release();
		assert.equal(existsSync(join(fixture.workspace, "created.txt")), false);
	},
);

test("independent env observer reads before watching and holds last valid state", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-env-store-"));
	const store = new EnvStore(directory);
	t.after(async () => {
		await store.observer.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await saveEnv(directory, "gpu", config);
	await store.observer.start();
	assert.equal(store.snapshot.configs.gpu?.host, "box");
	await writeFile(join(directory, "envs.json"), "bad");
	await poll(() => Boolean(store.snapshot.error));
	assert.equal(store.snapshot.configs.gpu?.host, "box");
	await saveEnv(directory, "gpu", config).catch(() => {}); // Invalid files are not overwritten by a partial mutation.
	assert.equal(await readFile(join(directory, "envs.json"), "utf8"), "bad");
});

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}
async function waitForPort(port: number): Promise<void> {
	await poll(
		() =>
			new Promise<boolean>((resolve) => {
				const socket = new Socket();
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("error", () => resolve(false));
				socket.connect(port, "127.0.0.1");
			}),
		10000,
		"local sshd",
	);
}

test(
	"remote sessions use SSH for directories/tools/uploads/prompt resources, trust host keys and confirm shares",
	{
		timeout: 180000,
		skip: !sshd
			? "no local sshd"
			: !existsSync(localDaemon())
				? `no packaged pi-env daemon at ${localDaemon()} (see apps/mobile/README Tests)`
				: (noTerminal ?? false),
	},
	async (t) => {
		const root = mkdtempSync(join(tmpdir(), "p2-env-ssh-"));
		const home = join(root, "home");
		mkdirSync(home);
		const sshPort = await freePort();
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host_key")]);
		writeFileSync(join(root, "authorized_keys"), "");
		writeFileSync(
			join(root, "sshd_config"),
			[
				`Port ${sshPort}`,
				"ListenAddress 127.0.0.1",
				`HostKey ${join(root, "host_key")}`,
				`AuthorizedKeysFile ${join(root, "authorized_keys")}`,
				`PidFile ${join(root, "sshd.pid")}`,
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"StrictModes no",
				`SetEnv HOME=${home}`,
				"",
			].join("\n"),
		);
		const sshServer: ChildProcess = spawn(sshd!, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
		t.after(async () => {
			sshServer.kill();
			if (sshServer.exitCode === null && sshServer.signalCode === null)
				await new Promise<void>((resolve) => sshServer.once("exit", () => resolve()));
			rmSync(root, { recursive: true, force: true });
		});
		await waitForPort(sshPort);
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const envs = owner.hold(Envs, {}, BACKGROUND_CONTEXT);
		const key = await envs.generateKey({ name: "box" }, BACKGROUND_CONTEXT);
		assert.match(key.publicKey, /^ssh-ed25519 /);
		writeFileSync(join(root, "authorized_keys"), `${key.publicKey}\n`);
		await envs.save(
			{
				name: "box",
				config: {
					type: "ssh",
					host: "127.0.0.1",
					port: sshPort,
					user: userInfo().username,
					identityFile: key.identityFile,
				},
			},
			BACKGROUND_CONTEXT,
		);
		assert.equal((await envs.generateKey({ name: "box" }, BACKGROUND_CONTEXT)).publicKey, key.publicKey);
		const untrusted = await envs.test({ name: "box" }, BACKGROUND_CONTEXT);
		assert(!untrusted.ok && untrusted.hostKey?.state === "unknown");
		const fingerprint = execFileSync("ssh-keygen", ["-lf", join(root, "host_key.pub")], { encoding: "utf8" }).split(
			" ",
		)[1]!;
		assert(untrusted.hostKey.fingerprints.join("\n").includes(fingerprint));
		await envs.acceptHostKey({ name: "box", lines: untrusted.hostKey.lines }, BACKGROUND_CONTEXT);
		const trusted = await envs.test({ name: "box" }, BACKGROUND_CONTEXT);
		assert(trusted.ok, trusted.ok ? "" : trusted.error);
		assert.equal(trusted.home, home);
		// The folder picker warms every environment's connection first (Pi Mobile's `envs` with `warm`).
		assert.equal(await envs.warm(BACKGROUND_CONTEXT), undefined);
		assert.equal((await envs.listDirectory({ env: "box", path: "~" }, BACKGROUND_CONTEXT)).path, home);
		const uploadedKey = await envs.uploadKey(
			{ name: "copy", key: readFileSync(key.identityFile, "utf8") },
			BACKGROUND_CONTEXT,
		);
		assert.equal(
			uploadedKey.publicKey.split(" ").slice(0, 2).join(" "),
			key.publicKey.split(" ").slice(0, 2).join(" "),
		);
		assert.equal((await stat(uploadedKey.identityFile)).mode & 0o777, 0o600);
		await envs.delete({ name: "copy" }, BACKGROUND_CONTEXT);
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create(
			{ env: "box", cwd: "~/project", createDirectory: true },
			BACKGROUND_CONTEXT,
		);
		assert.equal(session.env, "box");
		assert.equal(session.cwd, join(home, "project"));
		await writeFile(join(fixture.dataDir, "AGENTS.md"), "LOCAL GLOBAL sentinel");
		await writeFile(join(session.cwd, "AGENTS.md"), "REMOTE PROJECT sentinel");
		await mkdir(join(home, ".pi", "p2", "skills", "remote"), { recursive: true });
		await writeFile(
			join(home, ".pi", "p2", "skills", "remote", "SKILL.md"),
			"---\nname: remote\ndescription: Remote skill sentinel.\n---\nRemote instructions.",
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "write", requestId: "ssh-write" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => results(view, "write").length > 0, 60000);
		assert.equal(await readFile(join(session.cwd, "created.txt"), "utf8"), "before\n");
		const workspace = owner.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const remoteFile = await workspace.query({ kind: "file", path: "created.txt" }, BACKGROUND_CONTEXT);
		assert(remoteFile.kind === "file" && remoteFile.text === "before\n");
		workspace.release();
		await chat.send({ text: "bash", requestId: "ssh-bash" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => results(view, "bash").some((text) => text.includes(session.cwd)), 60000);
		const origin = `http://127.0.0.1:${fixture.server.port}`;
		const uploaded = await http(
			fixture.server.port,
			`/upload?${new URLSearchParams({ session: session.id, name: "notes.txt" })}`,
			{ method: "POST", headers: { Origin: origin }, body: "remote attachment" },
		);
		assert.equal(uploaded.status, 200, uploaded.body);
		const attachment = JSON.parse(uploaded.body) as { id: string };
		await chat.send(
			{ text: "see attachment", attachments: [attachment.id], requestId: "ssh-attachment" },
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, (view) => answered(view, "Echo: see attachment"), 60000);
		const remoteUploads = join(home, ".pi", "p2", "uploads", session.id);
		const files = await readdir(remoteUploads);
		assert.equal(files.length, 1);
		assert.equal(await readFile(join(remoteUploads, files[0]!), "utf8"), "remote attachment");
		await chat.send({ text: "send-file", requestId: "ssh-download" }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(view) => results(view, "send_file").some((text) => text.includes("Download ready")),
			60000,
		);
		const system = (view?.entries ?? [])
			.flatMap((entry) =>
				(entry.model ?? [])
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify(message)),
			)
			.join("\n");
		// The raw remote cwd and its SSH host (Pi Mobile's text, adapted), never the `box:/path` display form.
		const sections: Record<string, string> = {};
		for (const entry of view?.entries ?? [])
			for (const message of entry.model ?? [])
				if (message.role === "system")
					for (const [key, value] of Object.entries(message.sections ?? {}))
						if (value === null) delete sections[key];
						else sections[key] = value;
		const cwdSection = `${session.cwd}\nTools run on the remote environment "box" (SSH host 127.0.0.1), not on the machine running p2.`;
		assert.ok(sections.cwd?.includes(cwdSection), sections.cwd);
		assert.doesNotMatch(system, /box:\//);
		assert.match(sections.app ?? "", /skills: "~\/\.pi\/p2\/skills" on the remote environment "box"/);
		assert.match(sections.app ?? "", /owner keys\/tokens/);
		assert.match(system, /REMOTE PROJECT sentinel/);
		assert.match(system, /LOCAL GLOBAL sentinel/);
		assert.match(system, /Remote skill sentinel/);
		// The main agent's location tools see the environment (never its key) and where the session works.
		await chat.send({ text: "location_envs {}", requestId: "ssh-location-envs" }, BACKGROUND_CONTEXT);
		const listed = await until(chat.view, (view) => results(view, "location_envs").length > 0, 60000);
		const environments = results(listed, "location_envs")[0] ?? "";
		assert.match(environments, new RegExp(`You work at box:${session.cwd}`));
		assert.match(environments, /- box: ssh .*@127\.0\.0\.1:\d+ · tested ok .* · you are here/);
		assert.doesNotMatch(environments, /identity|BEGIN/);
		await assert.rejects(envs.delete({ name: "box" }, BACKGROUND_CONTEXT), /still use/);
		const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await assert.rejects(sharing.link({ mode: "full" }, BACKGROUND_CONTEXT), /Confirm first/);
		await sharing.link({ mode: "full", remoteConfirmed: true }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const terminals = owner.hold(Terminals, { session: session.id, view: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		const { token } = await terminals.channel({}, BACKGROUND_CONTEXT);
		const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.port}/terminal?${new URLSearchParams({ token })}`);
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
			await poll(() => events.some((event) => event.type === "attached" || event.type === "error"));
			const attached = events.find((event) => event.type === "attached");
			assert(attached?.type === "attached", JSON.stringify(events));
			assert.equal(attached.terminal.env, "box", "terminal host receives the coding session's catalog environment");
			assert.equal(attached.terminal.cwd, session.cwd);
			socket.send(Buffer.from("printf 'REMOTE_TERMINAL_SENTINEL\\n'\r"));
			await poll(() => Buffer.concat(output).toString("utf8").includes("REMOTE_TERMINAL_SENTINEL"));
			await terminals.close({ force: true }, BACKGROUND_CONTEXT);
		} finally {
			socket.close();
			await terminals.restartHost({}, BACKGROUND_CONTEXT).catch(() => {});
			terminals.release();
		}
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0);
		await chat.send({ text: "slow-tool", requestId: "ssh-busy-edit" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view).includes("tool-running"));
		await until(status.statuses, (statuses) => (statuses?.[session.id]?.tasks ?? 0) > 0);
		const saved = (await envs.list(BACKGROUND_CONTEXT))[0]!;
		await envs.save(
			{ name: "box", config: { ...saved.config, shellEnv: { P2_TEST_ENV_REVISION: "edited" } } },
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, (view) => results(view, "bash").some((text) => text.includes("tool-finished")), 60000);
		await until(status.statuses, (statuses) => statuses?.[session.id]?.running === false);
		chat.release();
		const reopened = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await reopened.send({ text: "after env revision", requestId: "ssh-restarted" }, BACKGROUND_CONTEXT);
		await until(reopened.view, (view) => answered(view, "Echo: after env revision"));
		await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0);
		reopened.release();

		// Pi Mobile 78056b34e: a subagent spawned without a cwd works in the session's remote cwd, and follows the
		// session when it moves (to this machine and back), never resolving a path of the other machine.
		const agents = await holdIn(owner, Subagents, {}, "reader");
		let sent = 0;
		const subagentPwd = async (requestId: string) => {
			await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0, 60000);
			const known = (await until(agents.children, (value) => value !== undefined))?.[session.id]?.some(
				(child) => child.name === "follow",
			);
			const args = known
				? { action: "send", name: "follow", message: "bash" }
				: { action: "spawn", name: "follow", message: "bash", tools: ["bash"] };
			const root = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
			await root.send({ text: `subagent ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);
			root.release();
			sent++;
			const listed = await until(agents.children, (value) =>
				Boolean(value?.[session.id]?.some((child) => child.name === "follow")),
			);
			const child = listed?.[session.id]?.find((entry) => entry.name === "follow");
			assert(child);
			const view = await holdIn(
				owner,
				Chat,
				{ session: session.id, conversation: child.conversationId },
				"participant",
			);
			try {
				const settled = await until(view.view, (value) => results(value, "bash").length >= sent, 60000);
				await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0, 60000);
				return results(settled, "bash").at(-1)?.trim();
			} finally {
				view.release();
			}
		};
		assert.equal(await subagentPwd("follow-remote"), session.cwd);
		// Moving to another machine and back happens in place: a viewer's Chat stays live, the worker is not restarted.
		const viewer = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const generation = () =>
			fixture.server.host.root(async (ctx) => {
				const hosts = await ctx.get(Hosts, {});
				return hosts.workers.value?.[session.id]?.generation;
			}, BACKGROUND_CONTEXT);
		const before = await generation();
		const local = join(root, "local");
		mkdirSync(local);
		await sessions.relocate({ id: session.id, cwd: local, env: null }, BACKGROUND_CONTEXT);
		await until(viewer.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === local);
		assert.equal(await subagentPwd("follow-local"), local);
		// The owner's case: a subagent spawned with its own directory on this machine keeps working here when the
		// session moves to the remote environment.
		const own = join(root, "own");
		mkdirSync(own);
		let ownRuns = 0;
		const ownPwd = async (requestId: string) => {
			await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0, 60000);
			const known = agents.children.value?.[session.id]?.some((child) => child.name === "mine");
			const args = known
				? { action: "send", name: "mine", message: "bash" }
				: { action: "spawn", name: "mine", message: "bash", cwd: own, tools: ["bash"] };
			const root = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
			await root.send({ text: `subagent ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);
			root.release();
			ownRuns++;
			const listed = await until(agents.children, (value) =>
				Boolean(value?.[session.id]?.some((child) => child.name === "mine")),
			);
			const child = listed?.[session.id]?.find((entry) => entry.name === "mine");
			assert(child);
			assert.deepEqual(child.location, { cwd: own, env: null });
			const view = await holdIn(
				owner,
				Chat,
				{ session: session.id, conversation: child.conversationId },
				"participant",
			);
			try {
				const settled = await until(view.view, (value) => results(value, "bash").length >= ownRuns, 60000);
				await until(status.statuses, (statuses) => statuses?.[session.id]?.tasks === 0, 60000);
				return results(settled, "bash").at(-1)?.trim();
			} finally {
				view.release();
			}
		};
		assert.equal(await ownPwd("own-local"), own);
		await sessions.relocate({ id: session.id, cwd: "~/project", env: "box" }, BACKGROUND_CONTEXT);
		await until(viewer.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === join(home, "project"));
		assert.equal(statusOf(viewer), "live");
		assert.equal(await generation(), before, "the same worker throughout");
		const moved = await until(sessions.sessions, (rows) => rows?.find((row) => row.id === session.id)?.env === "box");
		assert.equal(moved?.find((row) => row.id === session.id)?.cwd, join(home, "project"));
		assert.equal(
			await subagentPwd("follow-back"),
			join(home, "project"),
			"back on the remote env, never a local path",
		);
		assert.equal(await ownPwd("own-after-move"), own, "the subagent with its own location stays on this machine");
		agents.release();
		viewer.release();
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		await assert.rejects(envs.delete({ name: "box" }, BACKGROUND_CONTEXT), /still use/);
		await envs.forgetHostKey({ name: "box" }, BACKGROUND_CONTEXT);
		const forgotten = await envs.test({ name: "box" }, BACKGROUND_CONTEXT);
		assert(!forgotten.ok && forgotten.hostKey?.state === "unknown");
	},
);
