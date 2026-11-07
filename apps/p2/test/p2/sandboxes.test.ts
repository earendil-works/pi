// Gondolin sandboxes (plugins/envs, type "gondolin"): their configuration, the launcher's arguments, and confinement:
// a conversation working in a sandbox cannot leave it through the location tools, subagent placement or one-shot agents.
// The VM itself runs only with P2_TEST_GONDOLIN=1 (it needs /dev/kvm, QEMU >= 7.2 and Node >= 22, and downloads the guest
// image on first use), with pi-env's Linux daemon for this machine (static: the guest is Alpine) from P2_TEST_DAEMON or
// pi-env's package.

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	ConversationId,
	ConversationView,
	DocumentReader,
	ToolExecutionApi,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { compile } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, type Location } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import {
	type EnvsConfig,
	envRevision,
	isSandbox,
	loadEnvs,
	parseEnvs,
	saveEnv,
	validateEnv,
} from "../../plugins/envs/config.ts";
import { connectionRevision } from "../../plugins/envs/connection-revision.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import { remoteSession } from "../../plugins/envs/remote-env.ts";
import {
	launcherId,
	runLauncher,
	sandboxArgument,
	sandboxKey,
	sandboxRevision,
} from "../../plugins/envs/sandbox-host.ts";
import { LauncherCheckSchema } from "../../plugins/envs/sandbox-schema.ts";
import type { EnvInfo } from "../../plugins/locations/contract.ts";
import { createLocationExtension, sandboxAt } from "../../plugins/locations/tool.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { InheritedLocation, Subagents } from "../../plugins/subagents/contract.worker.ts";
import { ownLocation, placeTarget, type SubagentLocator } from "../../plugins/subagents/tools.ts";
import { Terminals } from "../../plugins/terminals/contract.ts";
import type { TerminalEvent } from "../../plugins/terminals/protocol.ts";
import { conversationConfinement, type ExecutionEnvironments } from "../../src/runtime/worker.ts";
import { holdIn, poll, startFixture, until } from "./helpers.ts";

const slayer = { type: "ssh" as const, host: "slayer.example" };
const box = {
	type: "gondolin" as const,
	host: "slayer",
	mounts: [{ host: "~/sbx/box1", guest: "/workspace" }],
	allowHosts: ["registry.npmjs.org", "*.github.com"],
};
const envs: EnvsConfig = { slayer, box1: box };
const sandboxDir = new URL("../../plugins/envs/sandbox/", import.meta.url);

test("sandbox configuration: validated alone and against its host", async () => {
	assert.deepEqual(validateEnv(box), box);
	for (const mounts of [
		[{ host: "relative/path", guest: "/w" }],
		[{ host: "~/a", guest: "relative" }],
		[{ host: "~/a", guest: "/" }],
		[{ host: "~/a", guest: "/w/../etc" }],
		[
			{ host: "~/a", guest: "/w" },
			{ host: "~/b", guest: "/w" },
		],
	])
		assert.throws(() => validateEnv({ ...box, mounts }), /folder|sandbox|Two folders|configuration/i);
	assert.throws(() => validateEnv({ ...box, allowHosts: ["a b"] }), /allowed host/);
	assert.throws(() => validateEnv({ ...box, host: "Not An Env" }), /host environment/);
	assert.throws(() => validateEnv({ ...box, image: "-rf" }), /image/);
	// SSH fields are not part of a sandbox: its connection goes through its host.
	assert.throws(() => validateEnv({ ...box, user: "root" }), /configuration/);
	assert.throws(() => parseEnvs(JSON.stringify({ box1: box })), /not an SSH environment/);
	assert.throws(() => parseEnvs(JSON.stringify({ other: box, slayer: { ...box, host: "other" } })), /not an SSH/);
	assert.deepEqual(parseEnvs(JSON.stringify(envs)), envs);
	assert.equal(isSandbox(envs, "box1"), true);
	assert.equal(isSandbox(envs, "slayer"), false);
	assert.equal(isSandbox(envs, "constructor"), false);
	const directory = mkdtempSync(join(tmpdir(), "p2-sandbox-config-"));
	try {
		await assert.rejects(saveEnv(directory, "box1", box), /not an SSH environment/);
		await saveEnv(directory, "slayer", slayer);
		await saveEnv(directory, "box1", box);
		await assert.rejects(saveEnv(directory, "slayer", undefined), /Sandboxes run on "slayer": box1/);
		await saveEnv(directory, "box1", undefined);
		await saveEnv(directory, "slayer", undefined);
		assert.deepEqual(await loadEnvs(directory), {});
		const session = remoteSession(directory, "box1", box, "/workspace");
		assert.equal(session.remote(), undefined, "constructing a sandbox session never connects");
		assert.equal(session.env.cwd, "/workspace");
		session.connection.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a sandbox's connection revision follows its host's configuration too", () => {
	const before = connectionRevision(envs, box);
	assert.equal(connectionRevision(envs, box), before);
	assert.notEqual(connectionRevision({ ...envs, slayer: { ...slayer, port: 2222 } }, box), before);
	assert.notEqual(connectionRevision(envs, { ...box, cpus: 4 }), before);
	assert.equal(connectionRevision(envs, slayer), envRevision(slayer));
});

test("launcher arguments: allowed hosts are always a list, values are quoted", () => {
	const decode = (config: typeof box) => JSON.parse(Buffer.from(sandboxArgument(config), "base64").toString("utf8"));
	// Gondolin allows every host when the list is omitted: an unset list must reach it as an empty one.
	assert.deepEqual(decode({ ...box, allowHosts: undefined } as unknown as typeof box).allowHosts, []);
	assert.deepEqual(decode(box), { mounts: box.mounts, allowHosts: box.allowHosts, diskGb: 32 });
	assert.notEqual(sandboxRevision(box), sandboxRevision({ ...box, allowHosts: [] }));
	assert.equal(runLauncher("/home/a b", ["daemon", "it's"]), `sh '/home/a b/p2-sandbox.sh' 'daemon' 'it'\\''s'`);
});

test("p2-sandbox.sh check reports the host as the manager expects", () => {
	const report: unknown = JSON.parse(
		execFileSync("sh", [new URL("p2-sandbox.sh", sandboxDir).pathname, "check"], { encoding: "utf8" }),
	);
	assert(compile(LauncherCheckSchema).check(report), JSON.stringify(report));
});

const infos: EnvInfo[] = [
	{ name: "slayer", type: "ssh", host: "slayer.example" },
	{ name: "box1", type: "gondolin", host: "slayer" },
];
const text = (result: ToolExecutionResult) =>
	(result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

test("location tools keep a sandboxed conversation in its sandbox", async () => {
	assert.equal(sandboxAt({ env: "box1", cwd: "/workspace" }, infos), "box1");
	assert.equal(sandboxAt({ env: "slayer", cwd: "/" }, infos), undefined);
	assert.equal(sandboxAt({ env: null, cwd: "/" }, infos), undefined);
	const listed: (string | null)[] = [];
	const extension = createLocationExtension({
		server: {
			envs: async () => infos,
			directories: async (env, path) => {
				listed.push(env);
				return { path, parent: null, directories: [`${path}/src`], truncated: false };
			},
		},
		locate: async () => ({ env: "box1", cwd: "/workspace" }),
	});
	const tool = (name: string) => {
		const found = extension.tools?.find((each) => each.name === name);
		assert(found);
		return found;
	};
	// The refusals come before anything reads the conversation's documents.
	const api = { conversationId: 2 as ConversationId } as unknown as ToolExecutionApi;
	const envsText = text(await tool("location_envs").execute({}, api, BACKGROUND_CONTEXT));
	assert.match(envsText, /in sandbox box1/);
	assert.match(envsText, /cannot leave it/);
	assert.doesNotMatch(envsText, /slayer\.example|this device/);
	for (const args of [{ location: "slayer:/home" }, { location: "local:/tmp" }, { env: null, cwd: "/tmp" }]) {
		for (const name of ["location_dirs", "location_move"]) {
			const result = await tool(name).execute(args, api, BACKGROUND_CONTEXT);
			assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
			assert.match(text(result), /sandbox box1 and cannot leave it/);
		}
	}
	assert.deepEqual(listed, [], "nothing outside the sandbox was even listed");
	const inside = await tool("location_dirs").execute({ location: "/workspace" }, api, BACKGROUND_CONTEXT);
	assert.equal(inside.isError, false);
	assert.match(text(inside), /box1:\/workspace/);
	assert.deepEqual(listed, ["box1"]);
});

test("a sandboxed caller places subagents only in its sandbox", async () => {
	const locator: SubagentLocator = {
		locate: async () => ({ env: "box1", cwd: "/workspace" }),
		sandbox: async (location) => (location.env === "box1" ? "box1" : undefined),
		directory: async (target) => ({ env: target.env, cwd: target.path || "/workspace" }),
	};
	const caller: Location = { env: "box1", cwd: "/workspace" };
	for (const args of [{ env: "slayer" }, { env: null }, { env: null, cwd: "/tmp" }])
		assert.match(String(await placeTarget(locator, caller, args, BACKGROUND_CONTEXT)), /only work inside it/);
	assert.deepEqual(await placeTarget(locator, caller, { cwd: "/workspace/a" }, BACKGROUND_CONTEXT), {
		env: "box1",
		cwd: "/workspace/a",
	});
	// An unsandboxed caller may place a subagent in a sandbox (which then confines that subagent).
	assert.deepEqual(await placeTarget(locator, { env: "slayer", cwd: "/" }, { env: "box1" }, BACKGROUND_CONTEXT), {
		env: "box1",
		cwd: "/workspace",
	});
});

test("confinement is decided per conversation from its location; one-shot agents inherit their caller's", async () => {
	const at: Record<number, Location> = { 1: { env: "slayer", cwd: "/" }, 2: { env: "box1", cwd: "/workspace" } };
	const environments = {
		session: at[1],
		locate: async (id: ConversationId) => at[Number(id)] ?? at[1],
		sandbox: async (env: string | null) => (env !== null && isSandbox(envs, env) ? env : undefined),
	} as unknown as ExecutionEnvironments;
	assert.equal(await conversationConfinement(environments, 1 as ConversationId, BACKGROUND_CONTEXT), undefined);
	assert.deepEqual(await conversationConfinement(environments, 2 as ConversationId, BACKGROUND_CONTEXT), {
		sandbox: "box1",
	});
	const docs = new Map<string, unknown>([
		[`${Subagents.definition.kind}:1`, { agents: { worker: { conversationId: 2, location: at[2] } }, reporters: {} }],
		[`${InheritedLocation.definition.kind}:3`, { location: at[2] }],
	]);
	const read = {
		snapshot: async (token: { definition: { kind: string } }, key: unknown) =>
			docs.get(`${token.definition.kind}:${String(key)}`),
	} as unknown as DocumentReader;
	assert.deepEqual(await ownLocation(read, 2 as ConversationId, BACKGROUND_CONTEXT), at[2]);
	assert.deepEqual(await ownLocation(read, 3 as ConversationId, BACKGROUND_CONTEXT), at[2], "a one-shot agent's");
	assert.equal(await ownLocation(read, 4 as ConversationId, BACKGROUND_CONTEXT), undefined);
});

test(
	"the launcher runs pi-env in a Gondolin VM with its folders and allowed hosts only",
	{ skip: process.env.P2_TEST_GONDOLIN !== "1", timeout: 900_000 },
	async (t) => {
		const daemon = process.env.P2_TEST_DAEMON ?? localDaemon();
		if (!existsSync(daemon)) return t.skip(`no pi-env daemon at ${daemon}`);
		const home = mkdtempSync(join(tmpdir(), "p2-gondolin-test-"));
		// Named as p2 deploys it (its installed Gondolin is shared with real use).
		const launcher = join(home, launcherId(fileURLToPath(sandboxDir)));
		mkdirSync(launcher);
		for (const name of ["p2-sandbox.sh", "p2-sandbox.mjs"])
			copyFileSync(new URL(name, sandboxDir), join(launcher, name));
		copyFileSync(new URL("host-package.json", sandboxDir), join(launcher, "package.json"));
		copyFileSync(new URL("host-package-lock.json", sandboxDir), join(launcher, "package-lock.json"));
		const shared = join(home, "shared");
		mkdirSync(shared);
		writeFileSync(join(shared, "hello.txt"), "from the host\n");
		const config = {
			...box,
			host: "unused",
			mounts: [{ host: shared, guest: "/workspace" }],
			allowHosts: [],
			diskGb: 3,
		};
		const name = `test-${process.pid}`;
		// As p2 does: start first (a first start installs and boots for longer than pi-env waits for its daemon).
		execFileSync("sh", [join(launcher, "p2-sandbox.sh"), "start", name, sandboxArgument(config)], {
			timeout: 660_000,
		});
		const launch = (...args: string[]) =>
			execFileSync("sh", [join(launcher, "p2-sandbox.sh"), ...args], { encoding: "utf8", timeout: 660_000 });
		let connection = new Connection({
			command: ["sh", join(launcher, "p2-sandbox.sh"), "daemon", name, sandboxArgument(config), daemon, "--"],
		});
		t.after(() => {
			connection.close();
			launch("forget", name);
			rmSync(home, { recursive: true, force: true });
		});
		const info = await connection.info();
		assert.equal(info.os, "linux");
		const env = new RemoteExecutionEnv({ connection, id: "sandbox-test", cwd: "/workspace" });
		const read = await env.readTextFile("/workspace/hello.txt", BACKGROUND_CONTEXT);
		assert.deepEqual(read, { ok: true, value: "from the host\n" });
		const wrote = await env.writeFile("/workspace/made.txt", "from the vm\n", BACKGROUND_CONTEXT);
		assert.equal(wrote.ok, true);
		assert.equal(readFileSync(join(shared, "made.txt"), "utf8"), "from the vm\n");
		const outside = await env.fileInfo(home, BACKGROUND_CONTEXT);
		assert.equal(outside.ok, false, "the host's other files are not in the VM");
		let output = "";
		const curl = await env.exec(
			"curl -s -o /dev/null -w '%{http_code}' https://example.com",
			{
				cwd: "/workspace",
				onOutput: (chunk) => {
					output += chunk;
				},
			},
			BACKGROUND_CONTEXT,
		);
		assert.equal(curl.ok, true);
		assert.equal(output, "403", "hosts outside the allowed list are refused");
		// Refused before the host resolves the name (else it leaks to DNS): an unresolvable name gets the policy's 403,
		// not the 502 of a failed lookup.
		output = "";
		await env.exec(
			"curl -s -o /dev/null -w '%{http_code}' http://leak-check.p2-sandbox.invalid/",
			{
				cwd: "/workspace",
				onOutput: (chunk) => {
					output += chunk;
				},
			},
			BACKGROUND_CONTEXT,
		);
		assert.equal(output, "403");

		// The VM's own disk: its configured size, and what is installed (here a file in the home) survives a restart.
		const run = async (command: string) => {
			let text = "";
			const onOutput = (chunk: string) => {
				text += chunk;
			};
			await env.exec(command, { cwd: "/", onOutput }, BACKGROUND_CONTEXT);
			return text.trim();
		};
		const sizeKb = Number(await run("df -k / | tail -1 | awk '{print $2}'"));
		assert(sizeKb > 2_500_000, `the root file system has grown to the disk size (${sizeKb} KB)`);
		assert.equal(await run("echo kept > /root/kept.txt && cat /root/kept.txt"), "kept");
		connection.close();
		launch("stop", name);
		launch("start", name, sandboxArgument(config));
		connection = new Connection({
			command: ["sh", join(launcher, "p2-sandbox.sh"), "daemon", name, sandboxArgument(config), daemon, "--"],
		});
		const restarted = new RemoteExecutionEnv({ connection, id: "sandbox-test-2", cwd: "/" });
		const kept = await restarted.readTextFile("/root/kept.txt", BACKGROUND_CONTEXT);
		assert.deepEqual(kept, { ok: true, value: "kept\n" }, "the home survives a restart");
		// A reset starts from the guest image again.
		connection.close();
		launch("reset", name);
		launch("start", name, sandboxArgument(config));
		connection = new Connection({
			command: ["sh", join(launcher, "p2-sandbox.sh"), "daemon", name, sandboxArgument(config), daemon, "--"],
		});
		const fresh = new RemoteExecutionEnv({ connection, id: "sandbox-test-3", cwd: "/" });
		assert.equal((await fresh.fileInfo("/root/kept.txt", BACKGROUND_CONTEXT)).ok, false, "a reset disk is fresh");
		// A VM killed without unmounting (a crash, a host reboot): the disk's journal lets the next start mount it.
		connection.close();
		const disk = `${name}.qcow2`;
		const qemu = execFileSync("pgrep", ["-f", `qemu-system.*${disk}`], { encoding: "utf8" })
			.trim()
			.split("\n");
		for (const pid of qemu) process.kill(Number(pid), "SIGKILL");
		await poll(() => launch("status", name).includes('"stopped"'), 30_000, "the supervisor notices the dead VM");
		launch("start", name, sandboxArgument(config));
		connection = new Connection({
			command: ["sh", join(launcher, "p2-sandbox.sh"), "daemon", name, sandboxArgument(config), daemon, "--"],
		});
		assert.equal((await connection.info()).os, "linux", "the disk mounts again after a crash");
	},
);

const sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].find((path) => existsSync(path));

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

test(
	"a session works in a sandbox on an SSH environment, and cannot leave it",
	{
		skip:
			process.env.P2_TEST_GONDOLIN !== "1"
				? "P2_TEST_GONDOLIN is not 1"
				: !sshd
					? "no local sshd"
					: !existsSync(localDaemon())
						? `no packaged pi-env daemon at ${localDaemon()}`
						: false,
		timeout: 900_000,
	},
	async (t) => {
		// A loopback sshd as this user with the real home: the launcher's installation and the guest image cache are
		// reused.
		const root = mkdtempSync(join(tmpdir(), "p2-sandbox-ssh-"));
		const port = await freePort();
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host_key")]);
		writeFileSync(join(root, "authorized_keys"), "");
		writeFileSync(
			join(root, "sshd_config"),
			[
				`Port ${port}`,
				"ListenAddress 127.0.0.1",
				`HostKey ${join(root, "host_key")}`,
				`AuthorizedKeysFile ${join(root, "authorized_keys")}`,
				`PidFile ${join(root, "sshd.pid")}`,
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"StrictModes no",
				"",
			].join("\n"),
		);
		const server: ChildProcess = spawn(sshd!, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
		const fixture = await startFixture();
		const owner = fixture.browser();
		const envs = owner.hold(Envs, {}, BACKGROUND_CONTEXT);
		t.after(async () => {
			// Everything is removed even when closing the fixture fails.
			try {
				await envs.sandboxStop({ name: "sbx" }, BACKGROUND_CONTEXT).catch(() => {});
				await fixture.close();
			} finally {
				if (server.exitCode === null && server.signalCode === null) {
					const exited = new Promise((resolve) => server.once("exit", resolve));
					server.kill();
					await exited;
				}
				rmSync(root, { recursive: true, force: true });
				for (const sandbox of ["sbx", "spare"]) {
					const key = sandboxKey(fixture.dataDir, sandbox);
					rmSync(join(homedir(), ".pi", "p2", "sandbox", "run", key), { recursive: true, force: true });
					rmSync(join(homedir(), ".pi", "p2", "sandbox", "disks", `${key}.qcow2`), { force: true });
				}
			}
		});
		await poll(
			() =>
				new Promise<boolean>((resolve) => {
					const socket = new Socket();
					socket.once("connect", () => resolve(Boolean(socket.destroy())));
					socket.once("error", () => resolve(false));
					socket.connect(port, "127.0.0.1");
				}),
			10_000,
			"local sshd",
		);
		const key = await envs.generateKey({ name: "host" }, BACKGROUND_CONTEXT);
		writeFileSync(join(root, "authorized_keys"), `${key.publicKey}\n`);
		const host = { type: "ssh" as const, host: "127.0.0.1", port, user: userInfo().username };
		await envs.save({ name: "host", config: { ...host, identityFile: key.identityFile } }, BACKGROUND_CONTEXT);
		const untrusted = await envs.test({ name: "host" }, BACKGROUND_CONTEXT);
		assert(!untrusted.ok && untrusted.hostKey);
		await envs.acceptHostKey({ name: "host", lines: untrusted.hostKey.lines }, BACKGROUND_CONTEXT);
		const tested = await envs.test({ name: "host" }, BACKGROUND_CONTEXT);
		assert(tested.ok, JSON.stringify(tested));
		assert(tested.sandboxes && tested.sandboxes.runtime !== "none", JSON.stringify(tested.sandboxes));

		const shared = join(root, "shared");
		mkdirSync(shared);
		writeFileSync(join(shared, "hello.txt"), "from the host\n");
		const sandbox = { type: "gondolin" as const, host: "host", mounts: [{ host: shared, guest: "/workspace" }] };
		await envs.save({ name: "sbx", config: sandbox }, BACKGROUND_CONTEXT);
		await envs.sandboxStop({ name: "sbx" }, BACKGROUND_CONTEXT);
		assert.deepEqual(await envs.sandboxStatus({ name: "sbx" }, BACKGROUND_CONTEXT), { state: "stopped" });
		// Deleting a sandbox stops its VM first: nothing could stop it once its configuration is gone.
		await envs.save({ name: "spare", config: sandbox }, BACKGROUND_CONTEXT);
		await envs.sandboxStart({ name: "spare" }, BACKGROUND_CONTEXT);
		await envs.delete({ name: "spare" }, BACKGROUND_CONTEXT);
		assert(
			!existsSync(join(homedir(), ".pi", "p2", "sandbox", "run", sandboxKey(fixture.dataDir, "spare"), "sock")),
			"the VM's supervisor is gone",
		);
		const vm = await envs.test({ name: "sbx" }, BACKGROUND_CONTEXT);
		assert(vm.ok && vm.platform === "linux", JSON.stringify(vm));
		const running = await envs.sandboxStatus({ name: "sbx" }, BACKGROUND_CONTEXT);
		assert(running.state === "running" && running.current, JSON.stringify(running));
		const listing = await envs.listDirectory({ env: "sbx", path: "/" }, BACKGROUND_CONTEXT);
		assert(listing.directories.includes("/workspace"), JSON.stringify(listing));

		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = (await sessions.create({ env: "sbx", cwd: "/workspace" }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const output = (view: ConversationView | null | undefined) =>
			(view?.entries ?? [])
				.flatMap((entry) => entry.model ?? [])
				.flatMap((message) => (message.role === "toolResult" ? message.content : []))
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n");
		const script = 'return (await tools.bash({ command: "cat hello.txt; echo made > made.txt; uname -s" })).output;';
		await chat.send({ text: `codemode ${script}`, requestId: "sandbox-bash" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => /from the host[\s\S]*Linux/.test(output(view)), 120_000);
		assert.equal(readFileSync(join(shared, "made.txt"), "utf8"), "made\n");
		await chat.send(
			{ text: `location_move ${JSON.stringify({ location: "host:/tmp" })}`, requestId: "sandbox-leave" },
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, (view) => output(view).includes("sandbox sbx and cannot leave it"), 60_000);
		chat.release();

		// A session outside places a subagent in the sandbox; configure cannot take it out again.
		const outside = (await sessions.create({ env: "host", cwd: root }, BACKGROUND_CONTEXT)).id;
		const main = await holdIn(owner, Chat, { session: outside, conversation: 1 }, "participant");
		const spawnArgs = {
			action: "spawn",
			name: "boxed",
			message: "hi",
			env: "sbx",
			cwd: "/workspace",
			tools: ["bash"],
		};
		await main.send(
			{ text: `subagent ${JSON.stringify(spawnArgs)}`, requestId: "sandbox-spawn" },
			BACKGROUND_CONTEXT,
		);
		// Its answer reported and the main agent idle again: inputs sent meanwhile would join the report's turn.
		await until(
			main.view,
			(view) =>
				(view?.entries ?? []).some((entry) => entry.kind === "p2.agent-message") &&
				!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run,
			60_000,
		);
		const results = (view: ConversationView | null | undefined) =>
			(view?.entries ?? []).flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
		let serial = 0;
		for (const change of [{ followSession: true }, { env: "host", cwd: root }]) {
			const configure = JSON.stringify({ action: "configure", name: "boxed", ...change });
			// Until its first task is done: a location never changes under a run.
			for (;;) {
				const before = results(await until(main.view, Boolean)).length;
				await main.send(
					{ text: `subagent ${configure}`, requestId: `sandbox-configure-${++serial}` },
					BACKGROUND_CONTEXT,
				);
				const view = await until(main.view, (value) => results(value).length > before, 60_000);
				const last = output({ ...view, entries: view?.entries.slice(-2) ?? [] } as ConversationView);
				if (last.includes("boxed works in sandbox sbx and cannot leave it")) break;
				assert.match(last, /is working/);
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
		main.release();

		// A terminal opens in the VM too.
		const terminals = owner.hold(Terminals, { session, view: crypto.randomUUID() }, BACKGROUND_CONTEXT);
		const { token } = await terminals.channel({}, BACKGROUND_CONTEXT);
		const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.port}/terminal?${new URLSearchParams({ token })}`);
		const events: TerminalEvent[] = [];
		const screen: Buffer[] = [];
		socket.on("message", (bytes, binary) => {
			if (binary) screen.push(Buffer.from(bytes as Buffer));
			else events.push(JSON.parse(bytes.toString()) as TerminalEvent);
		});
		socket.on("error", () => {});
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
			await terminals.open({ cols: 60, rows: 12, conversation: 1 }, BACKGROUND_CONTEXT);
			await poll(() => events.some((event) => event.type === "attached" || event.type === "error"), 60_000);
			const attached = events.find((event) => event.type === "attached");
			assert(attached?.type === "attached", JSON.stringify(events));
			assert.equal(attached.terminal.env, "sbx");
			socket.send(Buffer.from("cat /workspace/made.txt; uname -s\r"));
			await poll(() => /made[\s\S]*Linux/.test(Buffer.concat(screen).toString("utf8")), 30_000);
			await terminals.close({ force: true }, BACKGROUND_CONTEXT);
		} finally {
			socket.close();
			await terminals.restartHost({}, BACKGROUND_CONTEXT).catch(() => {});
			terminals.release();
		}
	},
);
