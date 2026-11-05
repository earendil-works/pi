// Cache warming in the session worker: a Durable extension whose `afterResponse` hook starts warming each
// conversation's last request (`./warmer.ts`), bound to the Harness, the settings and the worker's liveness.
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, LiveDoc, recordUsage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, defineFacet } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, harnessOf, isTopLevel, workerOf } from "@p2/app/v1/worker";
import { WorkerModels } from "../models/contract.ts";
import { CacheWarmingRuntime } from "./contract.ts";
import { ConversationWarmers } from "./warmer.ts";

export default defineFacet((host) => {
	host.serve(CacheWarmingRuntime, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const settings = self.get(WorkerModels, {});
		const durable = () => harness().durable;
		const context = BACKGROUND_CONTEXT;
		// Timers and in-flight refreshes live in this native: a reload or the worker's stop ends them, and the next
		// response starts warming again. Nothing of it is durable: the requests it repeats are not stored.
		const warmers = self.open(
			async () =>
				new ConversationWarmers({
					mode: () => settings.settings.value.cacheWarming ?? "idle",
					phase: async (conversationId, request) => {
						const running = (await durable().snapshot(LiveDoc, conversationId, context))?.run !== undefined;
						// After its run, a subagent's or one-shot agent's work is usually done; the main conversation and its
						// `/tree` branches wait for the person or for agents' reports.
						if (!running && !(await isTopLevel(durable(), conversationId, context))) return undefined;
						const conversation = await durable().conversation(conversationId, context);
						if (conversation === undefined) return undefined;
						const { model } = await conversation.agent(context);
						if (model?.provider !== request.model.provider || model.modelId !== request.model.id)
							return undefined;
						// A reset, compaction or edit replaced what the request sent: the next request starts differently.
						const current = (await conversation.context(context)).messages;
						if (!startsWith(current, request.messages)) return undefined;
						return running ? "streaming" : "idle";
					},
					record: async (conversationId, { provider, model, usage }) => {
						await durable().commit(
							(tx) => recordUsage(tx, conversationId, "models", `${provider}/${model}`, usage),
							context,
						);
					},
					keepAlive: (delta) => worker().liveness.add("cacheWarming", delta),
				}),
			(opened) => opened.close(),
		);
		const extension = defineExtension({
			name: "cache-warming",
			hooks: [
				hook(GenerationTask, {
					afterResponse: (response, api) => warmers.value.start(api.conversationId, response, api.models),
				}),
			],
		});
		// `cacheWarming: "off"` uninstalls the hook live; runs already warming stop at their next refresh.
		self.contribute(
			ExtensionSwitches,
			self.derive([settings.settings], ([value]) => ({ [extension.name]: value.cacheWarming !== "off" })),
		);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});

/** Whether `current` starts with `sent`, compared by role and timestamp. */
function startsWith(current: readonly Message[], sent: readonly Message[]): boolean {
	return (
		current.length >= sent.length &&
		sent.every(
			(message, index) => current[index]!.role === message.role && current[index]!.timestamp === message.timestamp,
		)
	);
}
