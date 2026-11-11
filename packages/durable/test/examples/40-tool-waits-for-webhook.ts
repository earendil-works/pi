// A tool that starts a CI build and parks until the build's webhook arrives, holding no process meanwhile. A crash
// before the park reruns the tool, which finds its build again through its own idempotency key; Stop while it is
// parked runs the tool's `cancel`, which cancels the build.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/40-tool-waits-for-webhook.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineSignal,
	defineTool,
	Harness,
	LiveDoc,
	type SignalToken,
	type TaskId,
	ToolResultEntry,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;
const HOUR = 60 * 60 * 1000;

// ─── The outside world: a CI service and the host's webhook registry ──────────

// Builds by idempotency key: triggering twice with one key starts one build.
const builds = new Map<string, { id: string; ref: string; cancelled: boolean }>();
const ci = {
	trigger: async (input: { ref: string; idempotencyKey: string }) => {
		let build = builds.get(input.idempotencyKey);
		if (build === undefined) {
			build = { id: `build-${builds.size + 1}`, ref: input.ref, cancelled: false };
			builds.set(input.idempotencyKey, build);
		}
		return { id: build.id };
	},
	cancel: async (buildId: string) => {
		for (const build of builds.values()) if (build.id === buildId) build.cancelled = true;
	},
	cancelByKey: async (idempotencyKey: string) => {
		const build = builds.get(idempotencyKey);
		if (build !== undefined) build.cancelled = true;
	},
};

// "When the webhook for `match` arrives, signal this key to this task": durable and idempotent in a real host.
const expected = new Map<string, { taskId: TaskId; token: SignalToken<CiResult>; key: string }>();
const webhooks = {
	expect: async (match: string, taskId: TaskId, token: SignalToken<CiResult>, key: string, _context: Context) => {
		expected.set(match, { taskId, token, key });
	},
	/** The CI service calls back; the host turns it into a signal. */
	deliver: async (harness: Harness, match: string, payload: CiResult) => {
		const target = expected.get(match)!;
		return harness.signal(target.taskId, target.token, target.key, payload, context);
	},
};

// ─── The tool ─────────────────────────────────────────────────────────────────

type CiResult = { status: "passed" | "failed"; logUrl: string };
const CiResult = defineSignal({
	name: "example.ci-result",
	version: 1,
	schema: obj({ status: oneOf(["passed", "failed"]), logUrl: str() }),
});

// Set by the host below to make the first attempt "crash" after it triggered the build.
let crashAfterTrigger = false;
let crashed = (): void => {};

const CiParameters = obj({ ref: str() });
const runCi = defineTool<typeof CiParameters, { buildId: string }, { buildId: string }>({
	name: "run_ci",
	description: "Run CI on a git ref and report the result",
	parameters: CiParameters,
	// A rerun after a crash is safe: it finds its build again by its idempotency key.
	replay: "safe",
	async execute({ ref }, api, ctx) {
		// The result, the deadline's expiry, or nothing yet (a fresh call, or a rerun after a crash before the park).
		const state = await api.readSignal(CiResult, "done", ctx);
		if (state !== undefined && "value" in state) {
			const { status, logUrl } = state.value;
			return { output: [{ type: "text", text: `CI ${status}: ${logUrl}` }], isError: status !== "passed" };
		}
		if (state !== undefined) {
			return {
				output: [{ type: "text", text: `CI build ${api.checkpoint?.buildId} never reported` }],
				isError: true,
			};
		}
		// The tool's own idempotency key, stable across reruns: memos are first-writer-wins.
		const runId = await api.memo("ci.run", crypto.randomUUID(), ctx);
		// Register before triggering, so a fast webhook already finds this task.
		await webhooks.expect(runId, api.taskId, CiResult, "done", ctx);
		const build = await ci.trigger({ ref, idempotencyKey: runId });
		await api.details({ buildId: build.id }, ctx);
		if (crashAfterTrigger) {
			crashed();
			// The process dies here; this attempt never parks.
			await new Promise((_, reject) => ctx.abortSignal?.addEventListener("abort", reject, { once: true }));
		}
		return {
			sleep: { checkpoint: { buildId: build.id }, signals: [CiResult.key("done")], until: api.now() + 2 * HOUR },
		};
	},
	async cancel(_args, api, ctx) {
		// Parked: the checkpoint names the build. Cut off before a park was stored: the idempotency key finds it.
		console.log(`  [cancel] cancelling ${api.checkpoint?.buildId ?? "the build of this call's key"}`);
		if (api.checkpoint !== undefined) await ci.cancel(api.checkpoint.buildId);
		else await ci.cancelByKey((await api.memo<string>("ci.run", ctx))!);
	},
});

// ─── Host ─────────────────────────────────────────────────────────────────────

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callCi = (ref: string) => fauxAssistantMessage(fauxToolCall("run_ci", { ref }), { stopReason: "toolUse" });
faux.setResponses([callCi("main"), fauxAssistantMessage("CI is green."), callCi("feature")]);

const registry = createRegistry();
registry.install(defineExtension({ name: "ci", tools: [runCi] }));
const directory = await mkdtemp(join(tmpdir(), "pi-durable-ci-"));
const open = async () =>
	Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry, onWake: () => {} },
		context,
	);
const slot = async (harness: Harness, root: Conversation) =>
	(await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0];
const parked = async (harness: Harness, root: Conversation) => {
	for (;;) {
		const found = await slot(harness, root);
		if (found?.status === "sleeping") return found.taskId!;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
};
const lastResult = async (root: Conversation) => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// 1. The first process starts the build and dies before the park is stored.
crashAfterTrigger = true;
const died = new Promise<void>((resolve) => {
	crashed = resolve;
});
const first = await open();
const firstRoot = await first.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
first.resume();
const submissionId = (await firstRoot.submit({ type: "input", content: "Run CI on main" }, context)).id;
await died;
console.log(
	"builds after the first attempt:",
	[...builds.values()].map((build) => build.id),
);

// 2. Another process opens the same database. The replay-safe call runs again and finds its build by its key.
crashAfterTrigger = false;
const harness = await open();
const root = await harness.root(context);
harness.resume();
await parked(harness, root);
console.log(
	"builds after the rerun:",
	[...builds.values()].map((build) => build.id),
);
console.log("parked slot:", await slot(harness, root));
await new Promise((resolve) => setTimeout(resolve, 1));
// Parked work holds no invocation: only its deadline needs a wakeup.
console.log(
	"wake while parked:",
	harness.wake(),
	"deadline in",
	Math.round((harness.wake().at! - Date.now()) / HOUR),
	"h",
);

// 3. The webhook arrives; the host delivers it, and the call runs again with the result. Retries are duplicates.
const [match] = expected.keys();
console.log("webhook:", await webhooks.deliver(harness, match!, { status: "passed", logUrl: "https://ci/1" }));
console.log("retry:", await webhooks.deliver(harness, match!, { status: "passed", logUrl: "https://ci/1" }));
await (await harness.submission(submissionId, context))!.wait(context);
console.log("result:", await lastResult(root));

// 4. A second build, stopped while parked: `cancel` cancels it, and the call ends aborted.
await root.submit({ type: "input", content: "Run CI on feature" }, context);
await parked(harness, root);
await root.abort(context);
console.log("builds:", [...builds.values()]);
console.log("result:", await lastResult(root));

await harness.close(context);
await first.close(context);
await rm(directory, { recursive: true, force: true });
