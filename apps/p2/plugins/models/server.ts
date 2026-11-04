import { obj, unknown } from "@earendil-works/pi-schema";
import {
	defineFacet,
	defineState,
	forbidden,
	isOwner,
	type JsonValue,
	unsafe,
	untilAborted,
	type Watchable,
} from "@p2/app/v1";
import { Server, serverOf } from "@p2/app/v1/server";
import { openResources, resourceState } from "./config.ts";
import { ModelConfig, ModelResources, ModelSummarySchema, Models } from "./contract.ts";
import type { ResourceSnapshot } from "./resources.ts";
import { resolveModelScope } from "./scope.ts";

/** What `ModelConfig` publishes of the configuration: the picker's summary and the secret-free snapshot. */
const Published = defineState("p2.model-config", {
	schema: obj({ summary: ModelSummarySchema, snapshot: unsafe<JsonValue>(unknown()) }),
	version: 1,
	initial: () => ({
		summary: { models: [], defaultModel: null, errors: [] },
		snapshot: { version: 0, settings: {}, credentials: [], providers: [], models: [], errors: [] },
	}),
});

export default defineFacet((host) => {
	host.serve(ModelResources, { compose: (table) => table[0]?.value });
	host.serve(ModelConfig, (_params, self) => {
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const published = self.state(Published);
		const resources = self.open(
			() => openResources(server.info.value.dataDir, server.info.value.fake, natives().resourceOptions),
			(opened) => opened.close(),
		);
		self.contribute(ModelResources, {
			get resources() {
				return resources.value;
			},
		});
		self.onLive(async (ctx) => {
			const publish = () =>
				published.change((draft) => {
					const state = resourceState(resources.value, server.info.value.fake);
					draft.summary = state.summary;
					draft.snapshot = state.snapshot as unknown as JsonValue;
				}, ctx);
			await publish();
			const stop = resources.value.subscribe(() => void publish().catch(() => {}));
			try {
				await untilAborted(ctx);
			} finally {
				stop();
			}
		});
		return {
			summary: self.derive([published], ([value]) => value.summary),
			// The snapshot is JSON (`Resources.snapshot()`); its type is the one the contract names.
			snapshot: self.derive([published], ([value]) => value.snapshot) as unknown as Watchable<ResourceSnapshot>,
			setDefault: async ({ provider, modelId, thinkingLevel }) => {
				const opened = resources.value;
				if (!opened.models.getModel(provider, modelId)) throw new Error("Unknown model");
				await opened.saveSettings({ ...opened.settings, defaultModel: { provider, modelId }, thinkingLevel });
				return null;
			},
			setEnabledModels: async ({ patterns }) => {
				const opened = resources.value;
				const { enabledModels: _previous, ...settings } = opened.settings;
				const cleaned = patterns.map((pattern) => pattern.trim()).filter(Boolean);
				await opened.saveSettings(cleaned.length ? { ...settings, enabledModels: cleaned } : settings);
				return null;
			},
		};
	});

	host.serve(Models, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("models are owner-only");
		const config = self.get(ModelConfig, {});
		return {
			variant: "owner",
			members: {
				models: self.derive([config.summary], ([summary]) => summary.models),
				defaultModel: self.derive([config.summary], ([summary]) => summary.defaultModel),
				errors: self.derive([config.summary], ([summary]) => summary.errors),
				enabledModels: self.derive([config.snapshot], ([snapshot]) => snapshot.settings.enabledModels ?? []),
				scopedModels: self.derive(
					[config.summary, config.snapshot],
					([summary, snapshot]) => resolveModelScope(snapshot.settings.enabledModels ?? [], summary.models).models,
				),
				resources: config.snapshot,
				setDefault: (choice, ctx) => config.setDefault(choice, ctx),
				setEnabledModels: (input, ctx) => config.setEnabledModels(input, ctx),
			},
		};
	});
});
