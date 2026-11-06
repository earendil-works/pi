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
import { EnvConfigSchema, SandboxMountSchema, SshEnvConfigSchema } from "./schema.ts";

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

/**
 * The owner's environments and sandboxes. 2: `EnvSummary.users` (the sessions using an environment), and `delete`'s
 * `force`: refused while sessions use the env unless `force`; their history stays, and their tools refuse to run until
 * they move to another location (never on this device instead). 3: a sandbox's `diskGb`, and `sandboxResetDisk`: stops
 * the VM and removes its disk, so the next start begins from the guest image again. The provider still serves 1 and 2
 * (its `accepts`).
 */
export const Envs = evolve(EnvsV2, (e) =>
	e
		.state("owner", "envs", arr(EnvSummarySchema))
		.result("list", arr(EnvSummarySchema))
		.args("save", obj({ name: str(), config: EnvConfigSchema }))
		.addMethod("owner", "sandboxResetDisk", Name, SandboxStatusSchema),
);

/** Browser-safe display: the machine is part of a directory's identity. */
export function environmentPath(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${cwd}` : cwd;
}
