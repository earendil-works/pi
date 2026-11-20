// Tests of the start-data objects: `AppInfo` on a server host, `WorkerInfo` on a worker's.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type P3Principal, Session } from "@earendil-works/p3/v1";
import { AppInfo, appInfoFacet, WorkerInfo, workerInfoFacet } from "../../src/kit/info.ts";

describe("start data", () => {
	it("serves AppInfo on the server: data directory, name, newest API version", async () => {
		const host = createHost<P3Principal>({ onError: (error) => assert.fail(String(error.kind)) });
		const facet = appInfoFacet({ dataDir: "/data", name: "p3", version: "v1" });
		await host.load([{ name: "p3.info", facet }], context);
		const info = await host.get(AppInfo, {}, context);
		assert.deepEqual([info.dataDir.value, info.name.value, info.version.value], ["/data", "p3", "v1"]);
		await host.close(context);
	});

	it("serves WorkerInfo on a worker: its address", async () => {
		const host = createHost<P3Principal>({ onError: (error) => assert.fail(String(error.kind)) });
		await host.load([{ name: "p3.worker-info", facet: workerInfoFacet(Session({ id: "s1" })) }], context);
		const info = await host.get(WorkerInfo, {}, context);
		assert.deepEqual(info.address.value, { kind: "session", key: "session|s1", params: { id: "s1" } });
		await host.close(context);
	});
});
