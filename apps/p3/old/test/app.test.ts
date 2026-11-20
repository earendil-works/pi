// p3 end to end in this process: the real server (`startP3`: the kit's HTTP, sign-ins, plugin builds, a forked worker
// per session) on a temporary data directory, driven by the case of `end-to-end.ts`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { startP3 } from "../src/bootstrap/server.ts";
import { endToEnd } from "./end-to-end.ts";

describe("p3 end to end, in this process", () => {
	let dir: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "p3-app-"));
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a session whose forked worker answers, starts none for an unknown one, and keeps it across a restart", async () => {
		const start = async (dataDir: string) => {
			const app = await startP3(context, { dataDir, port: 0, onStop: () => {} });
			return {
				ownerLink: () => app.ownerLink(),
				ownerTokenFile: app.ownerTokenFile,
				workers: async () => Object.keys(app.workers.state.value).length,
				close: () => app.close(context),
			};
		};
		await endToEnd(start, join(dir, "data"));
	});
});
