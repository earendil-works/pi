import { arr, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { DirectoryListingSchema, defineRegistry, literal, local, method, record, remote, serverHost } from "@p2/app/v1";
import type { EnvManager } from "./manager.ts";
import { EnvConfigSchema } from "./schema.ts";

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
			},
		},
	},
});

/** Browser-safe display: the machine is part of a directory's identity. */
export function environmentPath(env: string | null | undefined, cwd: string): string {
	return env ? `${env}:${cwd}` : cwd;
}
