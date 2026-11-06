import { arr, bool, int, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, record } from "@p2/app/v1";

/** Browser-safe configuration shape. No credentials are kept in envs.json. */
export const ENV_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A machine reached over SSH. */
export const SshEnvConfigSchema = obj({
	type: literal("ssh"),
	host: str({ minLength: 1, maxLength: 255 }),
	user: opt(str({ minLength: 1, maxLength: 255 })),
	port: opt(int({ minimum: 1, maximum: 65535 })),
	identityFile: opt(str({ minLength: 1, maxLength: 4096 })),
	shellPath: opt(str({ minLength: 1, maxLength: 4096 })),
	loginShell: opt(bool()),
	shellEnv: opt(record(str())),
});

/** A folder of the host shared with a sandbox at `guest`; `host` is absolute or starts with `~` (the host user's home). */
export const SandboxMountSchema = obj({
	host: str({ minLength: 1, maxLength: 4096 }),
	guest: str({ minLength: 2, maxLength: 4096 }),
	readonly: opt(bool()),
});

/**
 * A Gondolin sandbox: a VM on the SSH environment `host`. It sees only its folders and reaches only its allowed hosts
 * over HTTP(S); conversations working in it cannot leave it.
 */
export const GondolinEnvConfigSchema = obj({
	type: literal("gondolin"),
	host: str({ minLength: 1, maxLength: 32 }),
	image: opt(str({ minLength: 1, maxLength: 255 })),
	mounts: opt(arr(SandboxMountSchema, { maxItems: 16 })),
	allowHosts: opt(arr(str({ minLength: 1, maxLength: 255 }), { maxItems: 256 })),
	cpus: opt(int({ minimum: 1, maximum: 64 })),
	memoryMb: opt(int({ minimum: 256, maximum: 262144 })),
	/** Size of the VM's own disk, which keeps what is installed across restarts (default `DEFAULT_DISK_GB`; grows only). */
	diskGb: opt(int({ minimum: 1, maximum: 4096 })),
});

/** The disk size of a sandbox without `diskGb`. */
export const DEFAULT_DISK_GB = 32;

export const EnvConfigSchema = union([SshEnvConfigSchema, GondolinEnvConfigSchema]);
export type SshEnvConfig = Static<typeof SshEnvConfigSchema>;
export type GondolinEnvConfig = Static<typeof GondolinEnvConfigSchema>;
export type SandboxMount = Static<typeof SandboxMountSchema>;
export type EnvConfig = Static<typeof EnvConfigSchema>;
export type EnvsConfig = Record<string, EnvConfig>;

/** Whether `name` is a sandbox, decided by its configuration's type (never its name). */
export function isSandbox(envs: EnvsConfig, name: string): boolean {
	return Object.hasOwn(envs, name) && envs[name]?.type === "gondolin";
}
