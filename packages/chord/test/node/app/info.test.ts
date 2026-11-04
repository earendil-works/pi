// Tests of the start-data objects (slice 13 §1): `AppInfo` on the server (data directory, app name, newest API
// version) and `WorkerInfo` on a worker (its address and the start data `start` made for it), as plugins get them.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { remote, str, unknown } from "../../../src/contracts/index.ts";
import { AppInfo } from "../../../src/node/app/index.ts";
import { writePlugin } from "../plugins/support.ts";
import { API, Project, tempDir, testApp } from "./support.ts";

/** What the info plugin's worker facet shows of `WorkerInfo`. */
const Shown = remote("test.shown", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: { main: { state: { address: unknown(), start: unknown() } } },
});

const WORKER = [
	'import { defineFacet, hostKind, remote, str, unknown, WorkerInfo } from "@test/app/v1";',
	'const Project = hostKind("project", { id: str() });',
	'const Shown = remote("test.shown", { version: 1, params: { id: str() }, hostAddress: ({ id }) => Project({ id }), variants: { main: { state: { address: unknown(), start: unknown() } } } });',
	"export default defineFacet((host) => host.serve(Shown, (_params, _principal, self) => {",
	"\tconst info = self.get(WorkerInfo, {});",
	'\treturn { variant: "main", members: { address: self.derive([info.address], ([v]) => v), start: self.derive([info.start], ([v]) => v) } };',
	"}));",
].join("\n");

describe("start data", () => {
	it("serves AppInfo on the server: data directory, name, newest API version", async () => {
		const { app, dataDir } = await testApp({
			api: {
				...API,
				versions: ["v2", "v1"],
				modules: { ...API.modules, "@test/app/v2": API.modules["@test/app/v1"] },
			},
		});
		const info = await app.host.get(AppInfo, {}, context);
		expect([info.dataDir.value, info.name.value, info.version.value]).toEqual([dataDir, "chord-test", "v2"]);
		info.release();
		await app.close(context);
	});

	it("serves WorkerInfo on a worker: its address and its start data", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "info", "@test/info", { "worker.ts": WORKER });
		const { app } = await testApp({ root, withWorkers: true });
		const shown = await app.host.get(Shown, { id: "p7" }, context);
		expect(shown.address.value).toEqual({ kind: "project", key: "project|p7", params: { id: "p7" } });
		expect(shown.start.value).toEqual({ project: "project|p7" });
		shown.release();
		await app.close(context);
	}, 60_000);
});
