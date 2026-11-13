// The Harness's `Models` proxy remembers each generation request by its terminal message (`HarnessParts.requestOf`):
// the message `afterResponse` hooks get must be the object `streamSimple().result()` resolved with. If Durable ever
// copied it, cache warming would stop (rather than warm the wrong request); this test makes that visible.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { createP2Models } from "../../plugins/models/models.ts";
import { createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { Extensions } from "../../src/runtime/durable.ts";
import { openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { HOST } from "../../src/runtime/principals.ts";
import {
	HarnessConfig,
	HarnessHost,
	HarnessNative,
	type HarnessParts,
	Liveness,
	type ModelRequest,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { APP } from "./helpers.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

test("afterResponse hooks find the request that produced their message, once", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "p2-harness-requests-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	let parts: HarnessParts | undefined;
	const seen: { message: AssistantMessage; request: ModelRequest | undefined; again: ModelRequest | undefined }[] = [];
	const probe = defineExtension({
		name: "probe",
		hooks: [
			hook(GenerationTask, {
				afterResponse: (message) => {
					const request = parts!.requestOf(message);
					seen.push({ message, request, again: parts!.requestOf(message) });
				},
			}),
		],
	});
	const facets = [
		defineFacet((_host, self) =>
			self.contribute(HarnessConfig, { default: { models: () => createP2Models(true), settings: () => ({}) } }),
		),
		defineFacet((_host, self) => self.contribute(Extensions, { probe })),
	];

	const store = await openHostStore(sessionDirectory(dataDir, "s1"), { outbox: false }, BACKGROUND_CONTEXT);
	const host = createHost({ address: Session({ id: "s1" }), principal: HOST, store, onError: console.error });
	const init: WorkerInit = {
		app: APP,
		dataDir,
		fake: true,
		telemetry: false,
		generation: 1,
		values: { session: { id: "s1", cwd: dataDir, env: null, model: MODEL, thinkingLevel: "off" } },
	};
	const location = new SessionLocation({ cwd: dataDir, env: null });
	const core = workerCore(init, new Liveness(), location, store, (fn) => host.root(fn, BACKGROUND_CONTEXT), undefined);
	await host.load(
		[
			{ name: "@p2/core", facet: core },
			{ name: "models", facet: facets[0]! },
			{ name: "probe", facet: facets[1]! },
		],
		BACKGROUND_CONTEXT,
	);
	const holder = host.hold(HarnessHost, {}, BACKGROUND_CONTEXT);
	try {
		await whenLive(holder);
		parts = (await host.registry(HarnessNative, BACKGROUND_CONTEXT)).value!;
		const durable = parts.durable;
		durable.resume();
		// One user input: the fake model answers it in one request.
		const root = await durable.root(BACKGROUND_CONTEXT);
		await (await root.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		await durable.waitForIdle(BACKGROUND_CONTEXT);
	} finally {
		holder.release();
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	}

	assert.equal(seen.length, 1);
	const [{ message, request, again }] = seen as [(typeof seen)[number]];
	assert.equal(message.stopReason, "stop");
	assert.ok(request, "requestOf finds the message afterResponse got");
	assert.equal(again, undefined, "each response is taken once");
	assert.equal(request.model.provider, "faux");
	assert.equal(request.model.id, "faux-1");
	assert.deepEqual(
		request.messages.map((sent) => sent.role),
		["user"],
	);
	// Durable's options and the Harness's identity, without the attempt's own.
	assert.equal(typeof request.options.sessionId, "string");
	assert.ok(request.options.identity);
	assert.equal(request.options.signal, undefined);
	assert.equal(request.options.telemetry, undefined);
	assert.equal(request.options.onPayload, undefined);
});
