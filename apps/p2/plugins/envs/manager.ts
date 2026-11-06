import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileInfo } from "@earendil-works/pi-durable/env";
import {
	acceptHostKey,
	type Connection,
	connectSsh,
	detectPlatform,
	forgetHostKey,
	HostKeyChangedError,
	HostKeyUnknownError,
	RemoteExecutionEnv,
	type RemotePlatform,
	type SshTarget,
	scanHostKey,
} from "@earendil-works/pi-env";
import { compile } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { remotePaths, value } from "@p2/app/v1/node";
import {
	ENV_NAME,
	type EnvConfig,
	envId,
	envRevision,
	type GondolinEnvConfig,
	loadEnvs,
	type SshEnvConfig,
	saveEnv,
} from "./config.ts";
import { connectionRevision } from "./connection-revision.ts";
import type { DirectoryListing, EnvSummary, EnvTest, SandboxStatus, SandboxSupport } from "./contract.ts";
import { envConnection, type RemoteSession, remoteSession, sandboxHost, sshOptions } from "./remote-env.ts";
import { launcherCommand, sandboxArgument, sandboxKey, sandboxRevision } from "./sandbox-host.ts";
import { LauncherCheckSchema, LauncherStatusSchema } from "./sandbox-schema.ts";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const context = BACKGROUND_CONTEXT;
/** Directory browsing keeps a connection this long after its last use: a new one costs several ssh handshakes. */
const IDLE_MS = 600_000;
/** Most entries one listing reads; the first 1,000 directories are shown, as for local directories. */
const LISTING_SCAN = 10_000;
const LISTING_LIMIT = 1000;
/** Largest private key accepted by upload. */
const MAX_KEY_BYTES = 16 * 1024;

const run = promisify(execFile);
const checkReport = compile(LauncherCheckSchema);
const statusReport = compile(LauncherStatusSchema);

type Browser = { revision: string; session: RemoteSession; timer?: ReturnType<typeof setTimeout> };

/** Owner management of `envs.json`, host keys, connection tests and remote directory browsing for new sessions. */
export class EnvManager {
	readonly directory: string;
	private readonly uses: (name: string) => Promise<number>;
	private readonly tests = new Map<string, EnvTest>();
	private readonly browsers = new Map<string, Browser>();

	private readonly session: (name: string, config: EnvConfig) => RemoteSession;
	/** The sandbox launcher's source directory (this plugin's sandbox/). */
	private readonly launcher: string;

	/** `session` replaces SSH for tests: the environment that browses an env's directories. */
	constructor(
		directory: string,
		uses: (name: string) => Promise<number>,
		launcher: string,
		session: (name: string, config: EnvConfig) => RemoteSession = (name, config) =>
			remoteSession(directory, name, config, "/", { launcher }),
	) {
		this.directory = directory;
		this.uses = uses;
		this.launcher = launcher;
		this.session = session;
	}

	async config(name: string): Promise<EnvConfig> {
		const configs = await loadEnvs(this.directory);
		const config = Object.hasOwn(configs, name) ? configs[name] : undefined;
		if (!config) throw new Error(`Environment "${name}" is not configured`);
		return config;
	}

	/** An SSH env's configuration; sandboxes have no host keys or SSH keys of their own. */
	async sshConfig(name: string): Promise<SshEnvConfig> {
		const config = await this.config(name);
		if (config.type !== "ssh") throw new Error(`"${name}" is a sandbox; manage its host's SSH settings instead`);
		return config;
	}

	/**
	 * A pi-env connection to env `name` configured as `config` (a sandbox: through its host), with p2's key and known
	 * hosts, deploying the daemon pi-env ships. It starts at its first request; the caller closes it.
	 */
	connection(name: string, config: EnvConfig): Connection {
		return envConnection(this.directory, name, config, { launcher: this.launcher }).connection;
	}

	async list(): Promise<EnvSummary[]> {
		const envs = await loadEnvs(this.directory);
		return Promise.all(
			Object.entries(envs)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(async ([name, config]) => {
					const test = this.tests.get(`${name}@${envRevision(config)}`);
					return { name, config, sessions: await this.uses(name), ...(test ? { test } : {}) };
				}),
		);
	}

	/**
	 * Other changes of a sandbox apply when its VM restarts; moving it to another host stops the VM on the old one first
	 * (nothing could reach it afterwards), refusing the change when that fails.
	 */
	async save(name: string, config: EnvConfig): Promise<void> {
		const configs = await loadEnvs(this.directory);
		const previous = Object.hasOwn(configs, name) ? configs[name] : undefined;
		if (previous?.type === "gondolin" && (config.type !== "gondolin" || config.host !== previous.host))
			await this.sandboxStop(name).catch((error: unknown) => {
				throw new Error(
					`Could not stop sandbox ${name}'s VM on "${previous.host}", so it was not moved: ${errorMessage(error)}`,
				);
			});
		await saveEnv(this.directory, name, config);
		this.release(name);
	}

	/**
	 * Refused while any session, archived or not, references the env, unless `force`: sessions never fall back to local
	 * tools, so theirs refuse to run until they move. A sandbox's VM is stopped and its run directory removed first
	 * (nothing could stop it once its configuration is gone); deleting is refused when that fails.
	 */
	async delete(name: string, force = false): Promise<void> {
		const uses = await this.uses(name);
		if (uses > 0 && !force) throw new Error(`${uses} session${uses === 1 ? "" : "s"} still use "${name}"`);
		const configs = await loadEnvs(this.directory);
		if (Object.hasOwn(configs, name) && configs[name]?.type === "gondolin")
			await this.sandboxCommand(name, "forget").catch((error: unknown) => {
				throw new Error(`Could not stop sandbox ${name}'s VM, so it was not deleted: ${errorMessage(error)}`);
			});
		await saveEnv(this.directory, name, undefined);
		this.release(name);
		// A key p2 generated or stored for this env goes with it.
		const key = this.keyPath(name);
		await rm(key, { force: true });
		await rm(`${key}.pub`, { force: true });
	}

	/**
	 * Where p2 keeps an env's private key, in the private data directory. Keyed by name, so a key can be made
	 * while the env is still being created.
	 */
	keyPath(name: string): string {
		if (!ENV_NAME.test(name)) throw new Error("Invalid environment name");
		return join(this.directory, "ssh", "keys", name);
	}

	/** The public key of the env's managed private key, if p2 keeps one. */
	async publicKey(name: string): Promise<string | undefined> {
		return (await readFile(`${this.keyPath(name)}.pub`, "utf8").catch(() => undefined))?.trim();
	}

	/** A saved env uses `path` as its identity file from now on; an env being created gets it from its form. */
	private async adoptKey(name: string, path: string): Promise<void> {
		const configs = await loadEnvs(this.directory);
		const config = Object.hasOwn(configs, name) ? configs[name] : undefined;
		if (config?.type === "ssh" && config.identityFile !== path)
			await this.save(name, { ...config, identityFile: path });
	}

	/**
	 * A new ed25519 key for the env, kept in p2's data directory and used as its identity file; returns the
	 * public key to install on the host. An existing managed key is kept, so generating twice never locks you out.
	 */
	async generateKey(name: string): Promise<string> {
		const path = this.keyPath(name);
		if ((await this.publicKey(name)) === undefined) {
			await mkdir(join(this.directory, "ssh", "keys"), { recursive: true, mode: 0o700 });
			await rm(path, { force: true });
			await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `p2-${name}`, "-f", path]);
			await chmod(path, 0o600);
		}
		await this.adoptKey(name, path);
		const publicKey = await this.publicKey(name);
		if (publicKey === undefined) throw new Error("Could not generate a key");
		return publicKey;
	}

	/**
	 * Keep an existing private key (OpenSSH or PEM text) for the env and use it as its identity file; returns its public
	 * key. Keys with a passphrase are refused: nothing could type it when a session connects.
	 */
	async uploadKey(name: string, key: string): Promise<string> {
		this.keyPath(name);
		if (Buffer.byteLength(key) > MAX_KEY_BYTES || !key.includes("PRIVATE KEY")) throw new Error("Not a private key");
		const directory = join(this.directory, "ssh", "keys");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = join(directory, `.upload-${randomBytes(6).toString("hex")}`);
		try {
			await writeFile(temporary, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600, flag: "wx" });
			let publicKey: string;
			try {
				// An empty passphrase: a protected key fails here instead of when a session connects.
				publicKey = (await run("ssh-keygen", ["-y", "-P", "", "-f", temporary])).stdout.trim();
			} catch {
				throw new Error("The key is protected by a passphrase or is not a valid private key");
			}
			const path = this.keyPath(name);
			await rename(temporary, path);
			await writeFile(`${path}.pub`, `${publicKey}\n`, { mode: 0o600 });
			await this.adoptKey(name, path);
			return publicKey;
		} finally {
			await rm(temporary, { force: true });
		}
	}

	/**
	 * Connect as a session would (detect, deploy, start; a sandbox: start its VM), then measure what the Envs panel
	 * shows. An SSH env's test also reports whether it can host sandboxes.
	 */
	async test(name: string): Promise<EnvTest> {
		const config = await this.config(name);
		const key = `${name}@${envRevision(config)}`;
		const result = config.type === "ssh" ? await this.testSsh(name, config) : await this.testSandbox(name, config);
		this.tests.set(key, result);
		return result;
	}

	/** Measure a started connection: its home, round trip and watch mode. */
	private async measure(
		name: string,
		config: EnvConfig,
		connection: Connection,
		remote: { platform: string; arch: string },
		warnings: string[],
	): Promise<EnvTest> {
		const info = await connection.info();
		const env = new RemoteExecutionEnv({ connection, id: envId(name, config), cwd: info.home });
		const started = performance.now();
		value(await env.fileInfo(info.home, context));
		const latencyMs = Math.round(performance.now() - started);
		const watcher = value(await env.watch([{ path: info.home }], () => {}, context));
		const watchMode = watcher.mode;
		await watcher.stop(context);
		return {
			ok: true,
			testedAt: Date.now(),
			platform: remote.platform,
			arch: remote.arch,
			home: info.home,
			version: info.version,
			latencyMs,
			watchMode,
			warnings,
		};
	}

	private async testSandbox(name: string, config: GondolinEnvConfig): Promise<EnvTest> {
		const { connection } = envConnection(this.directory, name, config, {
			launcher: this.launcher,
			onLog: () => {},
		});
		try {
			const info = await connection.info();
			return await this.measure(name, config, connection, { platform: "linux", arch: info.arch }, []);
		} catch (error) {
			return { ok: false, testedAt: Date.now(), error: errorMessage(error) };
		} finally {
			connection.close();
		}
	}

	private async testSsh(name: string, config: SshEnvConfig): Promise<EnvTest> {
		const options = sshOptions(this.directory, name, config);
		let result: EnvTest;
		try {
			const { connection, remote } = await connectSsh({ ...options, onLog: () => {} });
			try {
				result = await this.measure(name, config, connection, remote, [...remote.warnings]);
				if (result.ok) result.sandboxes = await sandboxSupport(options, remote, this.launcher);
			} finally {
				connection.close();
			}
		} catch (error) {
			result = { ok: false, testedAt: Date.now(), error: errorMessage(error) };
			if (error instanceof HostKeyUnknownError || error instanceof HostKeyChangedError) {
				// Show what the host presents now; accepting it is the owner's decision.
				const scanned = await scanHostKey(options).catch(() => undefined);
				result.hostKey = {
					state: error instanceof HostKeyUnknownError ? "unknown" : "changed",
					fingerprints: scanned?.fingerprints ?? [],
					lines: scanned?.lines ?? [],
				};
			}
		}
		return result;
	}

	/** The host of sandbox `name` and the system it runs (Linux, or the error saying otherwise). */
	private async sandboxTarget(
		name: string,
	): Promise<{ config: GondolinEnvConfig; target: SshTarget; remote: RemotePlatform }> {
		const config = await this.config(name);
		if (config.type !== "gondolin") throw new Error(`"${name}" is not a sandbox`);
		const target = await sandboxHost(this.directory, name, config.host);
		const remote = await detectPlatform(target);
		if (remote.platform !== "linux")
			throw new Error(`Sandboxes need a Linux host; "${config.host}" runs ${remote.platform}`);
		return { config, target, remote };
	}

	/** Run a launcher command for sandbox `name` on its host and read the VM's state from its answer. */
	private async sandboxCommand(name: string, command: "status" | "start" | "stop" | "forget"): Promise<SandboxStatus> {
		const { config, target, remote } = await this.sandboxTarget(name);
		const key = sandboxKey(this.directory, name);
		const args = command === "start" ? [command, key, sandboxArgument(config)] : [command, key];
		const report = await launcherCommand(target, remote, this.launcher, args);
		// The host's answer is wire input.
		if (!statusReport.check(report)) throw new Error("Unexpected answer from the sandbox launcher");
		if (report.state === "stopped") return { state: "stopped" };
		return {
			state: "running",
			startedAt: report.startedAt,
			cpus: report.cpus,
			memoryMb: report.memoryMb,
			current: report.revision === sandboxRevision(config),
		};
	}

	sandboxStatus(name: string): Promise<SandboxStatus> {
		return this.sandboxCommand(name, "status");
	}

	async sandboxStart(name: string): Promise<SandboxStatus> {
		return this.sandboxCommand(name, "start");
	}

	/** Stops the VM; the browsing connection goes with it. */
	async sandboxStop(name: string): Promise<SandboxStatus> {
		this.release(name);
		return this.sandboxCommand(name, "stop");
	}

	async acceptHostKey(name: string, lines: readonly string[]): Promise<void> {
		await acceptHostKey(sshOptions(this.directory, name, await this.sshConfig(name)), lines);
		this.release(name);
	}

	async forgetHostKey(name: string): Promise<void> {
		await forgetHostKey(sshOptions(this.directory, name, await this.sshConfig(name)));
		this.release(name);
	}

	/** A connection for browsing an env's directories, shared and closed after a while without use. */
	private async browser(name: string): Promise<RemoteSession> {
		const configs = await loadEnvs(this.directory);
		const config = await this.config(name);
		// A sandbox's connection goes through its host: an edit of either starts a new one.
		const revision = connectionRevision(configs, config);
		let browser = this.browsers.get(name);
		if (browser?.revision !== revision) {
			this.release(name);
			browser = { revision, session: this.session(name, config) };
			this.browsers.set(name, browser);
		}
		const current = browser;
		clearTimeout(current.timer);
		current.timer = setTimeout(() => {
			if (this.browsers.get(name) !== current) return;
			this.browsers.delete(name);
			current.session.connection.close();
		}, IDLE_MS);
		current.timer.unref();
		return current.session;
	}

	private release(name: string): void {
		const browser = this.browsers.get(name);
		if (!browser) return;
		this.browsers.delete(name);
		clearTimeout(browser.timer);
		browser.session.connection.close();
	}

	/** An absolute path on the env: `~` is the remote home, a relative path is relative to it. */
	private async resolve(session: RemoteSession, path: string): Promise<string> {
		const { home } = await session.connection.info();
		const paths = await remotePaths(session.connection);
		const absolute = path === "~" || path.startsWith("~/") || paths.isAbsolute(path) ? path : paths.join(home, path);
		return value(await session.env.absolutePath(absolute, context));
	}

	/**
	 * Start the connections of every SSH env in the background, so the first listing does not wait for ssh. Sandboxes
	 * are left alone: connecting to one starts its VM.
	 */
	async warm(): Promise<void> {
		for (const [name, config] of Object.entries(await loadEnvs(this.directory)))
			if (config.type === "ssh")
				void this.browser(name)
					.then((session) => session.connection.info())
					.catch(() => {});
	}

	/**
	 * Subdirectories of `path` on the env, following symbolic links to directories, as for local directories. Two round
	 * trips: opening fails for anything but a directory, one page holds most folders, and the close is not waited for.
	 */
	async listDirectory(name: string, path: string): Promise<DirectoryListing> {
		const session = await this.browser(name);
		const paths = await remotePaths(session.connection);
		const resolved = await this.resolve(session, path);
		const opened = await session.env.openDirReader(resolved, context);
		if (!opened.ok)
			throw new Error(
				opened.error.code === "not_directory" ? "Working directory is not a directory" : opened.error.message,
			);
		const reader = opened.value;
		const entries: FileInfo[] = [];
		let complete = false;
		try {
			while (entries.length < LISTING_SCAN) {
				const page = value(await reader.next(1000, context));
				entries.push(...page.entries);
				if (page.done) {
					complete = true;
					break;
				}
			}
		} finally {
			void reader.close(context);
		}
		const directories = (
			await Promise.all(
				entries.map(async (entry) => {
					if (entry.kind === "directory") return entry.path;
					if (entry.kind !== "symlink") return undefined;
					// fileInfo does not follow links (lstat): resolve first. All links resolve in parallel.
					const target = await session.env.canonicalPath(entry.path, context);
					if (!target.ok) return undefined;
					const followed = await session.env.fileInfo(target.value, context);
					return followed.ok && followed.value.kind === "directory" ? entry.path : undefined;
				}),
			)
		)
			.filter((entry) => entry !== undefined)
			.toSorted((a, b) => a.localeCompare(b));
		const parent = paths.dirname(resolved);
		return {
			path: resolved,
			parent: parent === resolved ? null : parent,
			directories: directories.slice(0, LISTING_LIMIT),
			truncated: !complete || directories.length > LISTING_LIMIT,
		};
	}

	/** A session's working directory on the env: resolved, optionally created, and checked to be a directory. */
	async workingDirectory(name: string, path: string, create = false): Promise<string> {
		const session = await this.browser(name);
		const resolved = await this.resolve(session, path);
		if (create) value(await session.env.createDir(resolved, { recursive: true }, context));
		const info = value(
			await session.env.fileInfo(value(await session.env.canonicalPath(resolved, context)), context),
		);
		if (info.kind !== "directory") throw new Error("Working directory is not a directory");
		return resolved;
	}

	close(): void {
		for (const name of [...this.browsers.keys()]) this.release(name);
	}
}

/** Whether the host can run sandboxes, from the launcher's `check`; a failed check is a "none" with its error. */
async function sandboxSupport(target: SshTarget, remote: RemotePlatform, launcher: string): Promise<SandboxSupport> {
	if (remote.platform !== "linux")
		return { runtime: "none", detail: `Sandboxes need Linux; this host runs ${remote.platform}.` };
	let report: unknown;
	try {
		report = await launcherCommand(target, remote, launcher, ["check"]);
	} catch (error) {
		return { runtime: "none", detail: `The sandbox check failed: ${errorMessage(error)}` };
	}
	// The host's answer is wire input.
	if (!checkReport.check(report)) return { runtime: "none", detail: "The sandbox check answered unexpectedly." };
	if (report.runtime === "native")
		return { runtime: "native", detail: `Gondolin runs with QEMU ${report.qemu}, Node ${report.node} and KVM.` };
	const [major = 0, minor = 0] = report.qemu.split(".").map(Number);
	const missing: string[] = [];
	if (!report.kvm) missing.push(report.kvmDevice ? "/dev/kvm is not accessible to this user" : "there is no /dev/kvm");
	if (!report.qemu) missing.push("QEMU is not installed (on the PATH or in ~/.local/bin)");
	else if (major < 7 || (major === 7 && minor < 2))
		missing.push(`QEMU ${report.qemu} is too old (Gondolin needs 7.2)`);
	if (!report.node || Number(report.node.split(".")[0]) < 22)
		missing.push("Node 22 or newer is not installed (on the PATH or in ~/.local/bin)");
	return { runtime: "none", detail: `This host cannot run sandboxes: ${missing.join(", ")}.` };
}
