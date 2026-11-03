import {
	type Connection,
	RemoteExecutionEnv,
	type RemotePlatform,
	type SshConnectOptions,
	sshConnection,
} from "@earendil-works/pi-env";
import { type EnvConfig, envId, hostKeyAlias, knownHostsPath } from "./config.ts";

/** `connectSsh`/`sshConnection` options for an env of `envs.json`. */
export function sshOptions(directory: string, name: string, config: EnvConfig): SshConnectOptions {
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
	onLog?: (text: string) => void,
): RemoteSession {
	const { connection, remote } = sshConnection({
		...sshOptions(directory, name, config),
		...(onLog === undefined ? {} : { onLog }),
	});
	const at = (directory: string) =>
		new RemoteExecutionEnv({
			connection,
			id: envId(name, config),
			cwd: directory,
			...(config.shellPath === undefined ? {} : { shellPath: config.shellPath }),
			...(config.shellEnv === undefined ? {} : { shellEnv: config.shellEnv }),
		});
	return { env: at(cwd), connection, remote, at };
}
