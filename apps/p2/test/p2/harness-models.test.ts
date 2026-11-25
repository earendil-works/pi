// The Harness's model access while the models plugin's configuration is withdrawn (`src/runtime/harness-models.ts`): a
// restart of the object contributing it (a reload, here with a resource that opens slowly) withdraws "default" while
// Durable is open; a run started meanwhile waits for the configuration instead of failing. A first activation that
// fails once delays the Harness's start, nothing fails. A configuration that does not come back fails the call after
// the bound, saying why; an abort ends it as aborted.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, local, whenLive } from "@p2/app/v1";
import { createP2Models } from "../../plugins/models/models.ts";
import { createHost, defineFacet, Session } from "../../src/runtime/chord.ts";
import { harnessModels } from "../../src/runtime/harness-models.ts";
import { openHostStore, sessionDirectory } from "../../src/runtime/host-dirs.ts";
import { HOST } from "../../src/runtime/principals.ts";
import {
	HarnessConfig,
	HarnessHost,
	HarnessNative,
	Liveness,
	PluginLoad,
	SessionLocation,
	type WorkerInit,
	workerCore,
} from "../../src/runtime/worker.ts";
import { APP, NO_IMAGES, poll } from "./helpers.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

/** A models plugin as `plugins/models` has it: a host-lifetime object whose native opens first, then contributes. */
const TestModels = local("test.models", { version: 1, params: {}, members: {} });

/** The models facet; each activation's resource opens with `open` (it may wait or throw). */
const modelsFacet = (open: () => Promise<void>) =>
	defineFacet((host) =>
		host.serve(TestModels, (_params, self) => {
			const resources = self.open(
				async () => {
					await open();
					return createP2Models(true);
				},
				() => {},
			);
			self.contribute(HarnessConfig, { default: { models: () => resources.value, settings: () => ({}) } });
			return {};
		}),
	);

/** A worker host with the core and `models`, its Harness open and scheduling. */
async function worker(t: { after: (fn: () => Promise<void> | void) => void }, models: ReturnType<typeof modelsFacet>) {
	const dataDir = mkdtempSync(join(tmpdir(), "p2-harness-models-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const store = await openHostStore(sessionDirectory(dataDir, "s1"), { outbox: false }, BACKGROUND_CONTEXT);
	const host = createHost({ address: Session({ id: "s1" }), principal: HOST, store, onError: () => {} });
	const init: WorkerInit = {
		app: APP,
		dataDir,
		fake: true,
		telemetry: false,
		generation: 1,
		values: { session: { id: "s1", cwd: dataDir, env: null, model: MODEL, thinkingLevel: "off" } },
	};
	const core = workerCore(
		init,
		new Liveness(),
		new SessionLocation({ cwd: dataDir, env: null }),
		store,
		(fn) => host.root(fn, BACKGROUND_CONTEXT),
		NO_IMAGES,
		new PluginLoad(),
		undefined,
	);
	await host.load(
		[
			{ name: "@p2/core", facet: core },
			{ name: "models", facet: models },
		],
		BACKGROUND_CONTEXT,
	);
	const holder = host.hold(HarnessHost, {}, BACKGROUND_CONTEXT);
	t.after(async () => {
		holder.release();
		await host.close(BACKGROUND_CONTEXT);
		await store.close(BACKGROUND_CONTEXT);
	});
	await whenLive(holder);
	const durable = (await host.registry(HarnessNative, BACKGROUND_CONTEXT)).value!.durable;
	durable.resume();
	const config = await host.registry(HarnessConfig, BACKGROUND_CONTEXT);
	return { host, durable, config, core };
}

/** The last assistant message of the root conversation. */
async function lastAnswer(durable: Awaited<ReturnType<typeof worker>>["durable"]): Promise<AssistantMessage> {
	const root = await durable.root(BACKGROUND_CONTEXT);
	const { messages } = await root.context(BACKGROUND_CONTEXT);
	const answer = messages.findLast((message) => message.role === "assistant");
	assert(answer !== undefined, "an answer");
	return answer;
}

describe("the Harness's models while the configuration is withdrawn", () => {
	it("a run started while the models plugin restarts waits for its configuration, then answers", async (t) => {
		const { host, durable, config, core } = await worker(
			t,
			modelsFacet(async () => {}),
		);
		// The restart: a reload whose resource opens only once `opened` resolves.
		let open!: () => void;
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		await host.reload(
			[
				{ name: "@p2/core", facet: core },
				{ name: "models", facet: modelsFacet(() => opened) },
			],
			BACKGROUND_CONTEXT,
		);
		await poll(() => !config.value.has("default"), 5000, "the configuration withdrawn");
		const root = await durable.root(BACKGROUND_CONTEXT);
		const submission = await root.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT);
		// The run reached its model call and waits there.
		await new Promise((resolve) => setTimeout(resolve, 300));
		open();
		await submission.wait(BACKGROUND_CONTEXT);
		await durable.waitForIdle(BACKGROUND_CONTEXT);
		const answer = await lastAnswer(durable);
		assert.equal(answer.stopReason, "stop", answer.errorMessage);
	});

	it("a first activation that fails once only delays the Harness: the run answers", async (t) => {
		let failures = 0;
		const { durable } = await worker(
			t,
			modelsFacet(async () => {
				if (failures++ === 0) throw new Error("auth.json is not readable yet");
			}),
		);
		assert(failures >= 2, "the first open failed and was retried");
		const root = await durable.root(BACKGROUND_CONTEXT);
		await (await root.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		await durable.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal((await lastAnswer(durable)).stopReason, "stop");
	});

	it("a configuration that does not come back fails the call after the bound, and an abort ends it aborted", async () => {
		const faux = createP2Models(true);
		const model = faux.getModel("faux", "faux-1")!;
		const never = (signal: AbortSignal) =>
			new Promise<never>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		const withdrawn = harnessModels(
			{ current: () => undefined, present: never, diagnose: () => "HarnessConfig has no entries" },
			50,
		);
		const timedOut = await withdrawn.streamSimple(model, { messages: [] }).result();
		assert.equal(timedOut.stopReason, "error");
		assert.match(
			timedOut.errorMessage ?? "",
			/No model configuration installed \(models plugin\) for 0 s: HarnessConfig/,
		);
		const abort = new AbortController();
		const stream = withdrawn.streamSimple(model, { messages: [] }, { signal: abort.signal });
		abort.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		await assert.rejects(withdrawn.completeSimple(model, { messages: [] }), /No model configuration installed/);
	});

	it("lookups read the last configuration seen while it is withdrawn", () => {
		let present = true;
		const faux = createP2Models(true);
		const models = harnessModels({
			current: () => (present ? faux : undefined),
			present: async () => faux,
			diagnose: () => "",
		});
		assert(models.getModel("faux", "faux-1"));
		present = false;
		assert.equal(models.getModel("faux", "faux-1")?.id, "faux-1");
	});
});
