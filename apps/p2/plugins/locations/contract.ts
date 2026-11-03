// The location tools' server side (worker principals only): the environments an agent may move to, their directories,
// and moving the main agent (its session) once its turn has ended.

import { arr, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { DirectoryListingSchema, literal, method, remote, serverHost } from "@p2/app/v1";

/** One environment as an agent sees it: never keys or identity files. */
export const EnvInfoSchema = obj({
	name: str(),
	host: str(),
	user: opt(str()),
	port: opt(num()),
	/** The owner's last test of this configuration (Envs), if any. */
	tested: opt(
		union([obj({ ok: literal(true), platform: str(), arch: str() }), obj({ ok: literal(false), error: str() })]),
	),
});
export type EnvInfo = Static<typeof EnvInfoSchema>;

/** The worker attests that the owner started the calling turn; only such turns use the location tools. */
const Owner = literal("owner");

export const AgentLocations = remote("p2.agent-locations", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				/** The configured SSH environments (this device is always available besides them). */
				envs: method(obj({ origin: Owner }), obj({ envs: arr(EnvInfoSchema) })),
				/** Folders of `path` (absolute or `~`-relative) on `env` (null: this device), as the directory picker lists them. */
				directories: method(
					obj({
						origin: Owner,
						env: union([str(), nul()]),
						path: str({ minLength: 1 }),
					}),
					DirectoryListingSchema,
				),
				/**
				 * Moves the worker's session (`SessionMoves.relocate`); `refused` is why its busy worker could not be fenced
				 * (nothing moved).
				 */
				move: method(
					obj({
						origin: Owner,
						env: union([str(), nul()]),
						cwd: str({ minLength: 1 }),
					}),
					obj({ refused: union([str(), nul()]) }),
				),
			},
		},
	},
});
