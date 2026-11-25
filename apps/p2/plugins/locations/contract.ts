// The location tools' server side (worker principals only): the environments an agent may move to, their directories,
// and moving the main agent (its session) once its turn has ended.

import { arr, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { DirectoryListingSchema, literal, method, remote, serverHost } from "@p2/app/v1";

/** One environment as an agent sees it: never keys or identity files. */
export const EnvInfoSchema = obj({
	name: str(),
	/** `gondolin`: a sandbox, `host` naming the SSH environment it runs on; conversations working there cannot leave it. */
	type: union([literal("ssh"), literal("gondolin")]),
	host: str(),
	user: opt(str()),
	port: opt(num()),
	/** The owner's last test of this configuration (Envs), if any. */
	tested: opt(
		union([obj({ ok: literal(true), platform: str(), arch: str() }), obj({ ok: literal(false), error: str() })]),
	),
});
export type EnvInfo = Static<typeof EnvInfoSchema>;

export const AgentLocations = remote("p2.agent-locations", {
	/** 2: no `origin` (p2 has no per-turn authority). Only workers hold it, and they reload with the server. */
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				/** The configured SSH environments and sandboxes (this device is always available besides them). */
				envs: method(undefined, obj({ envs: arr(EnvInfoSchema) })),
				/** Folders of `path` (absolute or `~`-relative) on `env` (null: this device), as the directory picker lists them. */
				directories: method(
					obj({
						env: union([str(), nul()]),
						path: str({ minLength: 1 }),
					}),
					DirectoryListingSchema,
				),
				/**
				 * Moves the worker's session (`SessionMoves.relocate`); `refused` is why its busy worker could not be fenced
				 * (nothing moved). A session working in a sandbox only moves within it (only the owner's Relocate leaves it).
				 */
				move: method(
					obj({
						env: union([str(), nul()]),
						cwd: str({ minLength: 1 }),
					}),
					obj({ refused: union([str(), nul()]) }),
				),
			},
		},
	},
});
