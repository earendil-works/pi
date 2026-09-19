import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { onTestFinished, test } from "vitest";
import { kinds } from "../../../src/harness/pico3/harness.ts";
import { defineTask } from "../../../src/harness/pico3/types.ts";
import { ctx, open, resultOf } from "./helpers.ts";

test("terminal tasks stay readable (getTask, waitForTask, scans, typed outcome) after many retirements and after reopen; sidecars are unlinked", async () => {
	const k = defineTask<{ n: number }, { phase: "x" }, { n: number }, null, null>({
		name: "n",
		async initial() {
			return { next: { phase: "x" } };
		},
		phases: {
			async x(task) {
				return { done: () => ({ status: "completed", result: { n: task.input.n } }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	let env = await open({ backend: "jsonl", taskKinds: [k] });
	onTestFinished(() => env.close());
	const first = await env.root.commit(
		(tx) => tx.createTask(k, { n: 1 }, { conversationId: 1, background: true }),
		ctx,
	);
	await env.h.waitForTask(first.id, ctx);
	for (let i = 2; i <= 150; i++) {
		const ref = await env.root.commit(
			(tx) => tx.createTask(k, { n: i }, { conversationId: 1, background: true }),
			ctx,
		);
		await env.h.waitForTask(ref.id, ctx);
	}
	assert.deepEqual(resultOf(await env.h.getTask(first.id, ctx)), { n: 1 });
	assert.equal((await env.tasks()).filter((t) => t.status === "terminal").length, 150);
	const plugin = await env.root.commit(
		(tx) => tx.createTask(kinds.plugin, { handler: "none", input: null }, { conversationId: 1, background: true }),
		ctx,
	);
	await env.h.waitForTask(plugin.id, ctx);
	await env.crash();
	assert.deepEqual(
		readdirSync(env.dir!).filter((f) => f.startsWith("task-")),
		[],
	); // every live-only sidecar unlinked after its terminal record
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [k] });
	assert.deepEqual(resultOf(await env.h.getTask(first.id, ctx)), { n: 1 });
	assert.equal((await env.h.waitForTask(first.id, ctx)).status, "terminal");
	assert.equal((await env.h.getTask(plugin.id, ctx))?.outcome?.status, "failed"); // an outcome not represented by any entry survives
	assert.equal((await env.tasks()).filter((t) => t.kind === "n").length, 150);
	assert.equal((await env.h.getTask(first.id, ctx))?.checkpoint, undefined); // terminal checkpoints are dropped
});
