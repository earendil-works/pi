import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import {
	acceptHostKey,
	connectSsh,
	deployDaemon,
	detectPlatform,
	type RemotePlatform,
	type SshTarget,
	scanHostKey,
} from "../src/ssh.ts";
import { daemon } from "./daemon.ts";

/**
 * The conformance suite over a real SSH server on this machine, configured by CI: `PI_ENV_SSH_HOST`, `PI_ENV_SSH_USER`
 * `PI_ENV_SSH_KEY` and `PI_ENV_SSH_PROGRAM`. On Windows this covers deployment and the daemon's launch through the server's default shell.
 */
const host = process.env.PI_ENV_SSH_HOST;
const root = mkdtempSync(join(tmpdir(), "pi-env-ssh-external-"));
let connected: Promise<{ connection: Connection; remote: RemotePlatform }> | undefined;

async function connect(): Promise<{ connection: Connection; remote: RemotePlatform }> {
	connected ??= (async () => {
		const target: SshTarget = {
			host: host!,
			...(process.env.PI_ENV_SSH_USER === undefined ? {} : { user: process.env.PI_ENV_SSH_USER }),
			...(process.env.PI_ENV_SSH_PORT === undefined ? {} : { port: Number(process.env.PI_ENV_SSH_PORT) }),
			...(process.env.PI_ENV_SSH_KEY === undefined ? {} : { identityFile: process.env.PI_ENV_SSH_KEY }),
			...(process.env.PI_ENV_SSH_PROGRAM === undefined ? {} : { ssh: process.env.PI_ENV_SSH_PROGRAM }),
			knownHostsFile: join(root, "known_hosts"),
			hostKeyAlias: "pi-env-external",
		};
		// Each stage is logged, so a hang in CI shows where it is.
		const log = (text: string) => process.stderr.write(`[ssh-external ${new Date().toISOString()}] ${text}\n`);
		log("scanning the host key");
		await acceptHostKey(target, (await scanHostKey(target)).lines);
		log("detecting the platform");
		const remote = await detectPlatform(target);
		log(`detected ${JSON.stringify(remote)}; deploying`);
		log(`deployed ${await deployDaemon(target, remote, daemon)}; connecting`);
		const result = await connectSsh({ ...target, binary: daemon, onLog: (text) => log(`daemon: ${text.trim()}`) });
		log("connected; saying hello");
		log(`hello ${JSON.stringify(await result.connection.info())}`);
		return result;
	})();
	return connected;
}

afterAll(async () => {
	if (connected) (await connected).connection.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

const windows = process.platform === "win32";
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");

describe.skipIf(host === undefined)("SSH to this machine's server", () => {
	it("reaches the remote system through its default shell", async () => {
		const { connection, remote } = await connect();
		const info = await connection.info();
		expect(info.os).toBe(windows ? "windows" : process.platform === "darwin" ? "macos" : process.platform);
		if (windows) expect(remote.shell).toBe(process.env.PI_ENV_SSH_SHELL ?? "cmd");
	}, 120_000);
});

if (host !== undefined) {
	registerEnvConformance(
		{ describe, expect, it },
		"RemoteExecutionEnv over SSH",
		async (use) => {
			const { connection } = await connect();
			const info = await connection.info();
			const home = new RemoteExecutionEnv({ connection, id: "pi-env:external", cwd: info.home });
			const cwd = getOrThrow(await home.createTempDir("pi-env-conformance-", BACKGROUND_CONTEXT));
			try {
				await use(
					new RemoteExecutionEnv({ connection, id: "pi-env:external", cwd, watch: { pollIntervalMs: 100 } }),
				);
			} finally {
				await home.remove(cwd, { recursive: true, force: true }, BACKGROUND_CONTEXT);
			}
		},
		windows ? { shell: [gitBash, "-c"], symlinks: false } : {},
	);
}
