import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import {
	acceptHostKey,
	connectSsh,
	forgetHostKey,
	HostKeyChangedError,
	HostKeyUnknownError,
	type SshTarget,
	scanHostKey,
	sshConnection,
} from "../src/ssh.ts";
import { daemon } from "./daemon.ts";

/** The deployed daemon is named by its content. */
const deployedName = `pi-env-${createHash("sha256").update(readFileSync(daemon)).digest("hex").slice(0, 32)}`;
const context = BACKGROUND_CONTEXT;

function which(program: string): string | undefined {
	try {
		return execFileSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const sshd =
	process.platform === "win32"
		? undefined
		: (which("sshd") ?? (existsSync("/usr/sbin/sshd") ? "/usr/sbin/sshd" : undefined));

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

async function waitForPort(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = new Socket();
			socket.once("connect", () => resolve(true)).once("error", () => resolve(false));
			socket.connect(port, "127.0.0.1");
		}).finally(() => undefined);
		if (open) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("sshd did not start");
}

// A disposable sshd on localhost with its own host key, client key and home directory.
describe.skipIf(sshd === undefined)("SSH bootstrap", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-env-ssh-"));
	const home = join(root, "home");
	let server: ChildProcess | undefined;
	let target: SshTarget;

	beforeAll(async () => {
		execFileSync("mkdir", ["-p", home]);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host_key")]);
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "client_key")]);
		writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "client_key.pub")));
		const port = await freePort();
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
				`SetEnv HOME=${home}`,
				"",
			].join("\n"),
		);
		writeFileSync(join(root, "ssh_config"), "");
		server = spawn(sshd!, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
		await waitForPort(port);
		target = {
			host: "127.0.0.1",
			port,
			user: userInfo().username,
			identityFile: join(root, "client_key"),
			knownHostsFile: join(root, "known_hosts"),
			hostKeyAlias: "pi-env-test",
			configFile: join(root, "ssh_config"),
		};
	});

	afterAll(() => {
		server?.kill();
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses an untrusted host, then deploys and runs the daemon once its key is accepted", async () => {
		await expect(connectSsh({ ...target, binary: daemon })).rejects.toBeInstanceOf(HostKeyUnknownError);

		const scanned = await scanHostKey(target);
		const expected = execFileSync("ssh-keygen", ["-lf", join(root, "host_key.pub")], { encoding: "utf8" }).split(
			" ",
		)[1];
		expect(scanned.fingerprints.join("\n")).toContain(expected);
		await acceptHostKey(target, scanned.lines);

		mkdirSync(join(home, ".pi/mobile/tools"), { recursive: true });
		writeFileSync(join(home, ".pi/mobile/tools/pi-env-0123456789abcdef0123456789abcdef"), "old");
		const { connection, remote } = await connectSsh({ ...target, binary: daemon });
		try {
			expect(remote.home).toBe(home);
			const deployed = readFileSync(join(home, ".pi/mobile/tools", deployedName));
			expect(deployed.equals(readFileSync(daemon))).toBe(true);
			// Daemons of other contents are removed.
			expect(readdirSync(join(home, ".pi/mobile/tools")).filter((name) => name.startsWith("pi-env-"))).toEqual([
				deployedName,
			]);
			const env = new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd: home });
			getOrThrow(await env.writeFile("over-ssh.txt", "hello", context));
			expect(getOrThrow(await env.readTextFile("over-ssh.txt", context))).toBe("hello");
			const output: string[] = [];
			const result = getOrThrow(
				await env.exec(["sh", "-c", 'printf "%s" "$HOME"'], { onOutput: (text) => output.push(text) }, context),
			);
			expect(result.exitCode).toBe(0);
			expect(output.join("")).toBe(home);
		} finally {
			connection.close();
		}
	}, 60_000);

	it("reuses a verified daemon and replaces a tampered one", async () => {
		const file = join(home, ".pi/mobile/tools", deployedName);
		const before = statSync(file).mtimeMs;
		(await connectSsh({ ...target, binary: daemon })).connection.close();
		expect(statSync(file).mtimeMs).toBe(before);

		writeFileSync(file, "tampered");
		const { connection } = await connectSsh({ ...target, binary: daemon });
		try {
			expect(readFileSync(file).equals(readFileSync(daemon))).toBe(true);
			expect((await connection.info()).home).toBe(home);
		} finally {
			connection.close();
		}
	}, 60_000);

	it("verifies the daemon again before starting it after a lost connection", async () => {
		const { connection } = await connectSsh({ ...target, binary: daemon });
		const file = join(home, ".pi/mobile/tools", deployedName);
		try {
			const { pid } = await connection.info();
			process.kill(pid, "SIGKILL");
			await new Promise((done) => setTimeout(done, 300));
			// Linux refuses to write a running program's file.
			writeFileSync(file, "tampered");
			// The next start redeploys the verified binary instead of running whatever is there.
			expect((await connection.info()).pid).not.toBe(pid);
			expect(readFileSync(file).equals(readFileSync(daemon))).toBe(true);
		} finally {
			connection.close();
		}
	}, 60_000);

	it("starts the daemon through the login shell only when asked", async () => {
		// The login shell is the account's shell: sh and bash read .profile, zsh (the macOS default) reads .zprofile.
		writeFileSync(join(home, ".profile"), "export PI_ENV_LOGIN=yes\n");
		writeFileSync(join(home, ".zprofile"), "export PI_ENV_LOGIN=yes\n");
		const login = async (loginShell: boolean) => {
			const { connection } = await connectSsh({ ...target, binary: daemon, loginShell });
			try {
				const env = new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd: home });
				const output: string[] = [];
				getOrThrow(
					await env.exec(
						["sh", "-c", 'printf "%s" "$PI_ENV_LOGIN"'],
						{ onOutput: (text) => output.push(text) },
						context,
					),
				);
				return output.join("");
			} finally {
				connection.close();
			}
		};
		expect(await login(false)).toBe("");
		expect(await login(true)).toBe("yes");
	}, 60_000);

	it("connects lazily and reports a failed start as the error of the operation", async () => {
		const lazyTarget = { ...target, knownHostsFile: join(root, "lazy_known_hosts") };
		const { connection, remote } = sshConnection({ ...lazyTarget, binary: daemon });
		try {
			expect(remote()).toBeUndefined();
			const env = new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd: home });
			// Nothing is trusted yet: each operation fails with the reason and tries again.
			const read = await env.readTextFile("missing.txt", context);
			expect(read.ok ? "ok" : read.error.message).toMatch(/not trusted/);
			const command = await env.exec(["sh", "-c", "exit 0"], undefined, context);
			expect(command.ok ? "ok" : command.error.code).toBe("spawn_error");
			await acceptHostKey(lazyTarget, (await scanHostKey(lazyTarget)).lines);
			const accepted = await env.exec(["sh", "-c", "exit 0"], undefined, context);
			expect(accepted.ok ? accepted.value.exitCode : accepted.error.message).toBe(0);
			expect(remote()?.home).toBe(home);
		} finally {
			connection.close();
		}
	}, 60_000);

	it("accepts only host keys for the alias and never replaces a trusted key silently", async () => {
		const knownHosts = join(root, "accept_known_hosts");
		const scoped = { ...target, knownHostsFile: knownHosts };
		const key = (name: string) => {
			const file = join(root, name);
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
			return readFileSync(`${file}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
		};
		const first = key("accept_first");
		const second = key("accept_second");
		await expect(acceptHostKey(scoped, [`other-alias ${first}`])).rejects.toThrow();
		await expect(acceptHostKey(scoped, [`@cert-authority pi-env-test ${first}`])).rejects.toThrow();
		await Promise.all([
			acceptHostKey(scoped, [`pi-env-test ${first}`]),
			acceptHostKey(scoped, [`pi-env-test ${first}`]),
		]);
		expect(readFileSync(knownHosts, "utf8")).toBe(`pi-env-test ${first}\n`);
		await expect(acceptHostKey(scoped, [`pi-env-test ${second}`])).rejects.toBeInstanceOf(HostKeyChangedError);
		await forgetHostKey(scoped);
		await acceptHostKey(scoped, [`pi-env-test ${second}`]);
		expect(readFileSync(knownHosts, "utf8")).toBe(`pi-env-test ${second}\n`);
	});

	it("refuses a changed host key", async () => {
		const other = join(root, "other_key");
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
		const key = readFileSync(`${other}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
		const knownHosts = join(root, "changed_known_hosts");
		writeFileSync(knownHosts, `pi-env-test ${key}\n`);
		await expect(connectSsh({ ...target, knownHostsFile: knownHosts, binary: daemon })).rejects.toBeInstanceOf(
			HostKeyChangedError,
		);
	}, 60_000);
});
