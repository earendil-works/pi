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
	forgetHostKey,
	HostKeyChangedError,
	HostKeyUnknownError,
	RemoteExecutionEnv,
	scanHostKey,
	sshConnection,
} from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { remotePaths, value } from "@p2/app/v1/node";
import { ENV_NAME, type EnvConfig, envId, envRevision, loadEnvs, saveEnv } from "./config.ts";
import type { DirectoryListing, EnvSummary, EnvTest } from "./contract.ts";
import { type RemoteSession, remoteSession, sshOptions } from "./remote-env.ts";

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

type Browser = { revision: string; session: RemoteSession; timer?: ReturnType<typeof setTimeout> };

/** Owner management of `envs.json`, host keys, connection tests and remote directory browsing for new sessions. */
export class EnvManager {
	readonly directory: string;
	private readonly uses: (name: string) => Promise<number>;
	private readonly tests = new Map<string, EnvTest>();
	private readonly browsers = new Map<string, Browser>();

	private readonly session: (name: string, config: EnvConfig) => RemoteSession;

	/** `session` replaces SSH for tests: the environment that browses an env's directories. */
	constructor(
		directory: string,
		uses: (name: string) => Promise<number>,
		session: (name: string, config: EnvConfig) => RemoteSession = (name, config) =>
			remoteSession(directory, name, config, "/"),
	) {
		this.directory = directory;
		this.uses = uses;
		this.session = session;
	}

	async config(name: string): Promise<EnvConfig> {
		const configs = await loadEnvs(this.directory);
		const config = Object.hasOwn(configs, name) ? configs[name] : undefined;
		if (!config) throw new Error(`Environment "${name}" is not configured`);
		return config;
	}

	/**
	 * A pi-env connection to env `name` configured as `config`, over SSH with p2's key and known hosts, deploying the
	 * daemon pi-env ships. It starts at its first request; the caller closes it.
	 */
	connection(name: string, config: EnvConfig): Connection {
		return sshConnection(sshOptions(this.directory, name, config)).connection;
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

	async save(name: string, config: EnvConfig): Promise<void> {
		await saveEnv(this.directory, name, config);
		this.release(name);
	}

	/** Refused while any session, archived or not, references the env: sessions never fall back to local tools. */
	async delete(name: string): Promise<void> {
		const uses = await this.uses(name);
		if (uses > 0) throw new Error(`${uses} session${uses === 1 ? "" : "s"} still use "${name}"`);
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
		if (config && config.identityFile !== path) await this.save(name, { ...config, identityFile: path });
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

	/** Connect as a session would (detect, deploy, start), then measure what the Envs panel shows. */
	async test(name: string): Promise<EnvTest> {
		const config = await this.config(name);
		const key = `${name}@${envRevision(config)}`;
		const options = sshOptions(this.directory, name, config);
		const warnings: string[] = [];
		let result: EnvTest;
		try {
			const { connection, remote } = await connectSsh({ ...options, onLog: () => {} });
			try {
				const info = await connection.info();
				const env = new RemoteExecutionEnv({ connection, id: envId(name, config), cwd: info.home });
				const started = performance.now();
				value(await env.fileInfo(info.home, context));
				const latencyMs = Math.round(performance.now() - started);
				const watcher = value(await env.watch([{ path: info.home }], () => {}, context));
				const watchMode = watcher.mode;
				await watcher.stop(context);
				warnings.push(...remote.warnings);
				result = {
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
		this.tests.set(key, result);
		return result;
	}

	async acceptHostKey(name: string, lines: readonly string[]): Promise<void> {
		await acceptHostKey(sshOptions(this.directory, name, await this.config(name)), lines);
		this.release(name);
	}

	async forgetHostKey(name: string): Promise<void> {
		await forgetHostKey(sshOptions(this.directory, name, await this.config(name)));
		this.release(name);
	}

	/** A connection for browsing an env's directories, shared and closed after a while without use. */
	private async browser(name: string): Promise<RemoteSession> {
		const config = await this.config(name);
		const revision = envRevision(config);
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

	/** Start the connections of every env in the background, so the first listing does not wait for ssh. */
	async warm(): Promise<void> {
		for (const name of Object.keys(await loadEnvs(this.directory)))
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
