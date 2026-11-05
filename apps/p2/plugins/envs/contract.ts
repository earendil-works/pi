import { arr, bool, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { DirectoryListingSchema, defineRegistry, literal, local, method, record, remote, serverHost } from "@p2/app/v1";
import type { EnvManager } from "./manager.ts";
import { EnvConfigSchema } from "./schema.ts";

/** Whether an SSH env can host sandboxes: natively, through Docker, or not (`detail` says why or how). */
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
export const EnvSummarySchema = obj({
	name: str(),
	config: EnvConfigSchema,
	sessions: num(),
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
export const Envs = remote("p2.envs", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { envs: arr(EnvSummarySchema), failure: union([str(), nul()]) },
			methods: {
				list: method(undefined, arr(EnvSummarySchema)),
				/** Starts every environment's SSH connection in the background (the folder picker opened). */
				warm: method(),
				save: method(obj({ name: str(), config: EnvConfigSchema })),
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

/** Browser-safe display: the machine is part of a directory's identity. */
export function environmentPath(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${cwd}` : cwd;
}
