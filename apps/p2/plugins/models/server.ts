import { defineFacet, deriveTyped, followNative, forbidden, isOwner } from "@p2/app/v1";
import { Server, serverOf } from "@p2/app/v1/server";
import { openResources, resourceState } from "./config.ts";
import { ModelConfig, ModelResources, Models } from "./contract.ts";
import { resolveModelScope } from "./scope.ts";

export default defineFacet((host) => {
	host.serve(ModelResources, { compose: (table) => table[0]?.value });
	host.serve(ModelConfig, (_params, self) => {
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const resources = self.open(
			() => openResources(server.info.value.dataDir, server.info.value.fake, natives().resourceOptions),
			(opened) => opened.close(),
		);
		self.contribute(ModelResources, {
			get resources() {
				return resources.value;
			},
		});
		// The configuration files' state as the resources hold it: a save below resolves after its reload, which
		// told this source, so the caller's answer comes with the new state.
		const state = followNative(
			self,
			(changed) => resources.value.subscribe(changed),
			() => resourceState(resources.value, server.info.value.fake),
		);
		return {
			summary: self.derive([state], ([value]) => value.summary),
			snapshot: deriveTyped(self, [state], ([value]) => value.snapshot),
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
