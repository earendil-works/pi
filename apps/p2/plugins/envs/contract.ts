import { arr, bool, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	DirectoryListingSchema,
	defineRegistry,
	evolve,
	literal,
	local,
	method,
	record,
	remote,
	serverHost,
} from "@p2/app/v1";
import type { EnvManager } from "./manager.ts";
import { EnvConfigSchema, GondolinEnvConfigSchema, SandboxMountSchema, SshEnvConfigSchema } from "./schema.ts";

/**
 * Whether an SSH env can host sandboxes (`detail` says why or how). `docker` is no longer reported (launchers before
 * Docker was dropped); it stays in the schema so open pages keep binding.
 */
export const SandboxSupportSchema = obj({
	runtime: union([literal("native"), literal("docker"), literal("none")]),
	detail: str(),
});
export type SandboxSupport = Static<typeof SandboxSupportSchema>;

/**
 * A sandbox's VM: stopped, or running since `startedAt`; `current` is false while it runs an older configuration
 * (changes apply when it restarts).
 */
export const SandboxStatusSchema = union([
	obj({ state: literal("stopped") }),
	obj({ state: literal("running"), startedAt: num(), cpus: num(), memoryMb: num(), current: bool() }),
]);
export type SandboxStatus = Static<typeof SandboxStatusSchema>;

export const EnvTestSchema = union([
	obj({
		ok: literal(true),
		testedAt: num(),
		platform: str(),
		arch: str(),
		home: str(),
		version: str(),
		latencyMs: num(),
		watchMode: union([literal("native"), literal("polling")]),
		warnings: arr(str()),
		/** SSH envs: whether the host can run sandboxes. */
		sandboxes: opt(SandboxSupportSchema),
	}),
	obj({
		ok: literal(false),
		testedAt: num(),
		error: str(),
		hostKey: opt(
			obj({
				state: union([literal("unknown"), literal("changed")]),
				fingerprints: arr(str()),
				lines: arr(str()),
			}),
		),
	}),
]);
export type EnvTest = Static<typeof EnvTestSchema>;
/** A session using an environment (working there, or with a subagent whose own location is there). */
export const EnvUserSchema = obj({ id: str(), title: str(), main: num(), archived: bool() });
export type EnvUser = Static<typeof EnvUserSchema>;
export const EnvSummarySchema = obj({
	name: str(),
	config: EnvConfigSchema,
	sessions: num(),
	/** The sessions counted in `sessions` (the Envs sheet's list; absent from `list`). */
	users: opt(arr(EnvUserSchema)),
	test: opt(EnvTestSchema),
});
export type EnvSummary = Static<typeof EnvSummarySchema>;
export { type DirectoryListing, DirectoryListingSchema } from "@p2/app/v1";

/** Server-only independently observed configuration. No key material is in state. The SSH manager is `EnvManagers`. */
export const EnvService = local("p2.env-service", {
	version: 2,
	params: {},
	members: {
		configs: record(EnvConfigSchema),
		tests: record(obj({ revision: str(), test: EnvTestSchema })),
		test: method(obj({ name: str() }), EnvTestSchema),
		failure: union([str(), nul()]),
		reload: method(),
	},
});
/**
 * The server's SSH manager (`EnvService` contributes it once open): read `.value?.manager` at each use; a factory that
 * needs it declares `EnvService` too, so it waits for it.
 */
export const EnvManagers = defineRegistry<
	{ readonly manager: EnvManager },
	{ readonly manager: EnvManager } | undefined
>("p2.env-manager", { version: 1 });

const Name = obj({ name: str() });
const Key = obj({ publicKey: str(), identityFile: str() });

/** The environment configuration of versions 1 and 2 of `Envs`: sandboxes without `diskGb`. */
const EnvConfigSchemaV2 = union([
	SshEnvConfigSchema,
	obj({
		type: literal("gondolin"),
		host: str({ minLength: 1, maxLength: 32 }),
		image: opt(str({ minLength: 1, maxLength: 255 })),
		mounts: opt(arr(SandboxMountSchema, { maxItems: 16 })),
		allowHosts: opt(arr(str({ minLength: 1, maxLength: 255 }), { maxItems: 256 })),
		cpus: opt(int({ minimum: 1, maximum: 64 })),
		memoryMb: opt(int({ minimum: 256, maximum: 262144 })),
	}),
]);

/** 2a32a605a's `EnvSummarySchema`, for version 1 of `Envs`: without `users`. */
const EnvSummarySchemaV1 = obj({
	name: str(),
	config: EnvConfigSchemaV2,
	sessions: num(),
	test: opt(EnvTestSchema),
});

/** d07548004's `EnvSummarySchema`, for version 2 of `Envs`. */
const EnvSummarySchemaV2 = obj({
	name: str(),
	config: EnvConfigSchemaV2,
	sessions: num(),
	users: opt(arr(EnvUserSchema)),
	test: opt(EnvTestSchema),
});

/** Version 1, as 2a32a605a released it (open pages built then still bind it). */
const EnvsV1 = remote("p2.envs", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { envs: arr(EnvSummarySchemaV1), failure: union([str(), nul()]) },
			methods: {
				list: method(undefined, arr(EnvSummarySchemaV1)),
				/** Starts every environment's SSH connection in the background (the folder picker opened). */
				warm: method(),
				save: method(obj({ name: str(), config: EnvConfigSchemaV2 })),
				delete: method(Name),
				test: method(Name, EnvTestSchema),
				acceptHostKey: method(obj({ name: str(), lines: arr(str()) })),
				forgetHostKey: method(Name),
				generateKey: method(Name, Key),
				uploadKey: method(obj({ name: str(), key: str({ maxLength: 16384 }) }), Key),
				publicKey: method(Name, union([str(), nul()])),
				listDirectory: method(obj({ env: opt(str()), path: str() }), DirectoryListingSchema),
				/** A sandbox's VM state, read from its host. */
				sandboxStatus: method(Name, SandboxStatusSchema),
				/** Starts a sandbox's VM (with its current configuration) unless it runs. */
				sandboxStart: method(Name, SandboxStatusSchema),
				/** Stops a sandbox's VM; conversations working there reconnect and start it again at their next tool call. */
				sandboxStop: method(Name, SandboxStatusSchema),
			},
		},
	},
});

/** Version 2, as d07548004 released it: `EnvSummary.users`, and `delete`'s `force`. */
const EnvsV2 = evolve(EnvsV1, (e) =>
	e
		.state("owner", "envs", arr(EnvSummarySchemaV2))
		.result("list", arr(EnvSummarySchemaV2))
		.args("delete", obj({ name: str(), force: opt(bool()) })),
);

/** The environment configuration of version 3 of `Envs`: SSH environments and sandboxes. */
const EnvConfigSchemaV3 = union([SshEnvConfigSchema, GondolinEnvConfigSchema]);

/** The `EnvSummarySchema` of version 3 of `Envs`. */
const EnvSummarySchemaV3 = obj({
	name: str(),
	config: EnvConfigSchemaV3,
	sessions: num(),
	users: opt(arr(EnvUserSchema)),
	test: opt(EnvTestSchema),
});

/** Version 3: a sandbox's `diskGb`, and `sandboxResetDisk`. */
const EnvsV3 = evolve(EnvsV2, (e) =>
	e
		.state("owner", "envs", arr(EnvSummarySchemaV3))
		.result("list", arr(EnvSummarySchemaV3))
		.args("save", obj({ name: str(), config: EnvConfigSchemaV3 }))
		.addMethod("owner", "sandboxResetDisk", Name, SandboxStatusSchema),
);

/** One of the owner's machines at Radius (a server of kind `env`, running `pi-env agent`), as Radius lists it. */
export const RadiusMachineSchema = obj({
	server: str(),
	name: opt(str()),
	status: union([literal("online"), literal("offline"), literal("unknown")]),
	lastSeenAt: str(),
});
export type RadiusMachine = Static<typeof RadiusMachineSchema>;

/** A one-time code that enrolls a machine with Radius (an hour), and the commands that install `pi-env agent` with it. */
export const EnrollmentSchema = obj({
	code: str(),
	expiresAt: str(),
	gateway: str(),
	install: obj({ sh: str(), ps1: str() }),
});
export type Enrollment = Static<typeof EnrollmentSchema>;

/** `pi-env agent` installed on an SSH environment: its Radius server ID and the service that runs it. */
export const InstalledSchema = obj({ server: str(), service: str() });
export type Installed = Static<typeof InstalledSchema>;

/**
 * The owner's environments and sandboxes. 2: `EnvSummary.users` (the sessions using an environment), and `delete`'s
 * `force`: refused while sessions use the env unless `force`; their history stays, and their tools refuse to run until
 * they move to another location (never on this device instead). 3: a sandbox's `diskGb`, and `sandboxResetDisk`: stops
 * the VM and removes its disk, so the next start begins from the guest image again. 4: machines running `pi-env agent`
 * through Radius (`type: "radius"`): `machines` lists the owner's machines at Radius, `enroll` mints a code with the
 * commands that install the agent, `install` installs it as a service on an SSH environment (the owner then saves the
 * environment as a Radius machine). The provider still serves 1 to 3 (its `accepts`), without Radius machines.
 */
export const Envs = evolve(EnvsV3, (e) =>
	e
		.state("owner", "envs", arr(EnvSummarySchema))
		.result("list", arr(EnvSummarySchema))
		.args("save", obj({ name: str(), config: EnvConfigSchema }))
		.addMethod("owner", "machines", obj({}), arr(RadiusMachineSchema))
		.addMethod("owner", "enroll", obj({ name: opt(str({ maxLength: 64 })) }), EnrollmentSchema)
		.addMethod("owner", "install", Name, InstalledSchema),
);

/** Browser-safe display: the machine is part of a directory's identity. */
export function environmentPath(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${cwd}` : cwd;
}

/** A sandbox secret as the owner sees it: its name, hosts, preset and when its value was set; never the value. */
export const SecretInfoSchema = obj({ name: str(), hosts: arr(str()), preset: opt(str()), setAt: num() });
export type SecretInfoView = Static<typeof SecretInfoSchema>;

/**
 * Sandbox secrets (owner only): values the sandbox's HTTP proxy injects into outbound request headers for their hosts,
 * while the VM only sees placeholders (`secrets.ts`). Changes apply when the sandbox's VM starts next.
 */
export const SandboxSecrets = remote("p2.sandbox-secrets", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			methods: {
				list: method(Name, arr(SecretInfoSchema)),
				/** `value` absent: keep the stored value; `addHosts`: allow the hosts the sandbox does not allow yet. */
				set: method(
					obj({
						sandbox: str(),
						name: str({ minLength: 1, maxLength: 64 }),
						value: opt(str({ minLength: 1, maxLength: 16_384 })),
						hosts: arr(str({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 32 }),
						preset: opt(str({ maxLength: 32 })),
						addHosts: opt(bool()),
					}),
				),
				delete: method(obj({ sandbox: str(), name: str() })),
			},
		},
	},
});
