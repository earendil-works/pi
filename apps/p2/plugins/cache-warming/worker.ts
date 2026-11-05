// Cache warming in the session worker: a Durable extension whose generation hooks start, idle and stop the warming of
// each conversation's last request (`./warmer.ts`), bound to the Harness, the settings and the worker's liveness.
import { defineExtension, GenerationTask, hook, LiveDoc, recordUsage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, defineFacet } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, harnessOf, isTopLevel, workerOf } from "@p2/app/v1/worker";
import { WorkerModels } from "../models/contract.ts";
import { CacheWarmingRuntime } from "./contract.ts";
import { ConversationWarmers, extendsMessages } from "./warmer.ts";

export default defineFacet((host) => {
	host.serve(CacheWarmingRuntime, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const settings = self.get(WorkerModels, {});
		const durable = () => harness().durable;
		// Timers and in-flight refreshes live in this native: a reload or the worker's stop ends them, and the next
		// response starts warming again. Nothing of it is durable: the requests it repeats are not stored.
		const warmers = self.open(
			async () =>
				new ConversationWarmers({
					mode: () => settings.settings.value.cacheWarming ?? "idle",
					now: () => Date.now(),
					setTimer: (fn, delayMs) => {
						const timer = setTimeout(fn, delayMs);
						return () => clearTimeout(timer);
					},
					isCurrent: async (conversationId, request) => {
						const conversation = await durable().conversation(conversationId, BACKGROUND_CONTEXT);
						if (conversation === undefined) return false;
						const { model } = await conversation.agent(BACKGROUND_CONTEXT);
						if (model?.provider !== request.model.provider || model.modelId !== request.model.id) return false;
						return extendsMessages((await conversation.context(BACKGROUND_CONTEXT)).messages, request.messages);
					},
					running: async (conversationId) =>
						(await durable().snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT))?.run !== undefined,
					// After a subagent's or one-shot agent's run its work is usually done; the main conversation and its
					// `/tree` branches wait for the person or for agents' reports.
					warmsIdle: (conversationId) => isTopLevel(durable(), conversationId, BACKGROUND_CONTEXT),
					record: async (conversationId, message) => {
						await durable().commit(
							(tx) =>
								recordUsage(
									tx,
									conversationId,
									"models",
									`${message.provider}/${message.model}`,
									message.usage,
								),
							BACKGROUND_CONTEXT,
						);
					},
					keepAlive: (delta) => worker().liveness.add("cacheWarming", delta),
					report: (error) => console.error("p2 cache-warming: refreshing the prompt cache failed:", error),
				}),
			(opened) => opened.close(),
		);
		const extension = defineExtension({
			name: "cache-warming",
			hooks: [
				hook(GenerationTask, {
					afterResponse: (response, api) => warmers.value.start(api.conversationId, response, api.models),
					afterRun: (_run, api) => {
						warmers.value.settled(api.conversationId);
						return undefined;
					},
				}),
			],
		});
		// `cacheWarming: "off"` uninstalls the hooks live; runs already warming stop at their next refresh.
		self.contribute(
			ExtensionSwitches,
			self.derive([settings.settings], ([value]) => ({ [extension.name]: value.cacheWarming !== "off" })),
		);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});
