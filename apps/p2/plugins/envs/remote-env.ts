import {
	Connection,
	type ConnectionOptions,
	deployDaemon,
	detectPlatform,
	packagedDaemon,
	RemoteExecutionEnv,
	type RemotePlatform,
	type SshConnectOptions,
	sshArguments,
	sshConnection,
} from "@earendil-works/pi-env";
import { type EnvConfig, envId, hostKeyAlias, knownHostsPath, loadEnvs, type SshEnvConfig } from "./config.ts";
import { deployedCommand, deployLauncher, runLauncher, sandboxArgument, sandboxKey } from "./sandbox-host.ts";
import { sandboxSecrets } from "./secrets.ts";

/** `connectSsh`/`sshConnection` options for an SSH env of `envs.json`. */
export function sshOptions(directory: string, name: string, config: SshEnvConfig): SshConnectOptions {
	return {
		host: config.host,
		...(config.user === undefined ? {} : { user: config.user }),
		...(config.port === undefined ? {} : { port: config.port }),
		...(config.identityFile === undefined ? {} : { identityFile: config.identityFile }),
		...(config.loginShell ? { loginShell: true } : {}),
		knownHostsFile: knownHostsPath(directory),
		hostKeyAlias: hostKeyAlias(name),
	};
}

export type EnvConnectOptions = {
	/**
	 * The sandbox launcher's source directory (this plugin's sandbox/: `pluginFile("sandbox")` in a facet); needed by
	 * sandboxes only.
	 */
	launcher?: string;
	/** The daemon to run (default: the one pi-env ships for the machine). */
	binary?: string;
	onLog?: ConnectionOptions["onLog"];
};

/** A connection and, once it started, the system it runs on (a sandbox's: Linux on its host's architecture). */
export type EnvConnection = { connection: Connection; remote(): RemotePlatform | undefined };

/**
 * A pi-env connection to env `name` that starts at its first request: over SSH for an SSH env; for a sandbox, over SSH
 * to its host, where p2's launcher starts the sandbox's VM if needed and runs the daemon in it. A sandbox's host
 * configuration is read from `directory`'s envs.json at each start.
 */
export function envConnection(
	directory: string,
	name: string,
	config: EnvConfig,
	options: EnvConnectOptions = {},
): EnvConnection {
	if (config.type === "ssh")
		return sshConnection({
			...sshOptions(directory, name, config),
			...(options.binary === undefined ? {} : { binary: options.binary }),
			...(options.onLog === undefined ? {} : { onLog: options.onLog }),
		});
	let remote: RemotePlatform | undefined;
	const { launcher } = options;
	const connection = new Connection({
		command: async () => {
			if (launcher === undefined) throw new Error(`No sandbox launcher to start sandbox ${name}`);
			const host = await sandboxHost(directory, name, config.host);
			const detected = remote ?? (await detectPlatform(host));
			if (detected.platform !== "linux")
				throw new Error(`Sandboxes need a Linux host; "${config.host}" runs ${detected.platform}`);
			remote = detected;
			// The VM is Linux on the host's architecture: the host's own daemon runs in it.
			const daemon = await deployDaemon(host, detected, options.binary ?? packagedDaemon(detected));
			const deployed = await deployLauncher(host, detected, launcher);
			// Start the VM first, with the launcher's own allowance (a first start may install Gondolin and download the
			// guest image): the daemon connection must answer within pi-env's 30 s once it runs.
			const key = sandboxKey(directory, name);
			// Secret values go on stdin, never on a command line; the argument names them.
			const secrets = await sandboxSecrets(directory, name);
			const argument = sandboxArgument(config, secrets.meta);
			await deployedCommand(host, deployed, ["start", key, argument], JSON.stringify(secrets.values));
			return [
				host.ssh ?? "ssh",
				...sshArguments(host),
				runLauncher(deployed, ["daemon", key, argument, daemon, "--"]),
			];
		},
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
	return { connection, remote: () => remote };
}

/** The SSH options of sandbox `name`'s host `host`, as configured now. */
export async function sandboxHost(directory: string, name: string, host: string): Promise<SshConnectOptions> {
	const configs = await loadEnvs(directory);
	const config = Object.hasOwn(configs, host) ? configs[host] : undefined;
	if (config?.type !== "ssh") throw new Error(`Sandbox ${name} runs on "${host}", which is not an SSH environment`);
	return sshOptions(directory, host, config);
}

export type RemoteSession = {
	env: RemoteExecutionEnv;
	connection: Connection;
	/** The detected remote system, once the connection has started. */
	remote(): RemotePlatform | undefined;
	/** Another environment on the same connection, at another directory (a subagent's own cwd). */
	at(cwd: string): RemoteExecutionEnv;
};

/**
 * A remote environment at `cwd` that connects at its first operation: building it never needs the network, and a
 * failed start (offline, untrusted host key) is the error of the operation that needed it.
 */
export function remoteSession(
	directory: string,
	name: string,
	config: EnvConfig,
	cwd: string,
	options: Omit<EnvConnectOptions, "binary"> = {},
): RemoteSession {
	const { connection, remote } = envConnection(directory, name, config, options);
	const shellPath = config.type === "ssh" ? config.shellPath : undefined;
	const shellEnv = config.type === "ssh" ? config.shellEnv : undefined;
	const at = (directory: string) =>
		new RemoteExecutionEnv({
			connection,
			id: envId(name, config),
			cwd: directory,
			...(shellPath === undefined ? {} : { shellPath }),
			...(shellEnv === undefined ? {} : { shellEnv }),
		});
	return { env: at(cwd), connection, remote, at };
}
