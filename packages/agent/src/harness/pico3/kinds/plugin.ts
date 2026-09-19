import type { Context } from "@earendil-works/chord";
import { type JsonValue, type Kind, type Runtime, type Step, type Task, toStored } from "../types.ts";
import { taskApi } from "./task-api.ts";

export type PluginInput = { handler: string; input: JsonValue };
type PluginCheckpoint = { phase: "started" };
type PluginFailure = { reason: "missing_handler" | "threw"; detail: string };

const pluginKind: Kind<PluginInput, PluginCheckpoint, JsonValue, PluginFailure, null> = {
	name: "pi.plugin",
	inflight: ["started"],
	phases: {
		async started(task, runtime, ctx) {
			return run(task, runtime, ctx);
		},
	},
	async initial(task, runtime, ctx) {
		await runtime.commit((tx) => tx.checkpoint({ phase: "started" }), ctx);
		return run(task, runtime, ctx);
	},
	async abort() {
		return async () => null;
	},
};
export const plugin = Object.freeze(pluginKind);

async function run(
	task: Task<PluginInput, PluginCheckpoint>,
	runtime: Runtime,
	ctx: Context,
): Promise<Step<PluginCheckpoint, JsonValue, PluginFailure>> {
	const handler = runtime.plugins.get(task.input.handler);
	if (handler === undefined) {
		return { done: () => ({ status: "failed", failure: { reason: "missing_handler", detail: task.input.handler } }) };
	}
	try {
		const result = toStored(await handler(task.input.input, taskApi(task, runtime), ctx));
		return { done: () => ({ status: "completed", result }) };
	} catch (error) {
		if (ctx.abortSignal?.aborted) throw error;
		return { done: () => ({ status: "failed", failure: { reason: "threw", detail: String(error) } }) };
	}
}
