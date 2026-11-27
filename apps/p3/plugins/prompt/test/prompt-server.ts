// The prompt plugin's tests' server: `kindServer` for one of its kinds, beside a stand-in of the base's
// `ServerRuntime` whose data directory is a temporary one of the test's (the skills root is under it), removed at
// `close`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, type Contract, defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import type { ThingKind } from "../../things/kind.ts";
import { type KindServer, kindServer } from "../../things/test/kind-server.ts";
import { skillsRoot } from "../folder.ts";
import promptServer from "../server.ts";

/** The prompt plugin's root. */
export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A kind of the prompt plugin on a test server, and the Pi's skills root there. */
export type PromptServer<C extends Contract> = KindServer<C> & { readonly root: string };

/** Starts the prompt plugin's server facet for `Kind` beside the things plugin's, on a data directory of its own. */
export async function promptKind<C extends Contract>(Kind: ThingKind<C>, context: Context): Promise<PromptServer<C>> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-prompt-"));
	// The plugin reads only the data directory of the base's runtime.
	const runtime = { dataDir, workRoot: join(dataDir, "work"), machine: { user: "test", hostname: "test" } };
	const beside = [
		{
			name: "p3.server",
			facet: defineFacet((host) => host.serve(ServerRuntime, { compose: () => runtime as ServerRuntime })),
		},
	];
	const plugin = { name: "@earendil-works/p3-prompt", root: ROOT, server: promptServer };
	const n = await kindServer(plugin, Kind, context, beside);
	return {
		...n,
		root: skillsRoot(dataDir),
		close: async () => {
			try {
				await n.close();
			} finally {
				await rm(dataDir, { recursive: true, force: true });
			}
		},
	};
}
