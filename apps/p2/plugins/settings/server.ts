// The Settings sheet's server side: settings.json as the model configuration holds it, changed through its save.
import { defineFacet, deriveTyped, forbidden, isOwner, nativeOf } from "@p2/app/v1";
import { validateSettings } from "@p2/app/v1/node";
import { ModelConfig, ModelResources } from "../models/contract.ts";
import { Settings } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(Settings, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("settings are owner-only");
		const config = self.get(ModelConfig, {});
		const resources = nativeOf(self, ModelResources, "The model configuration");
		return {
			variant: "owner",
			members: {
				settings: deriveTyped(self, [config.snapshot], ([snapshot]) => snapshot.settings),
				error: self.derive(
					[config.snapshot],
					([snapshot]) => snapshot.errors.find((error) => error.resource === "settings")?.message ?? null,
				),
				update: async ({ set, unset }) => {
					const opened = resources().resources;
					// Wire input: a partial settings.json under the same closed schema, so no unknown setting gets in.
					const changes = validateSettings(set);
					// Merged into the file's settings as they are now, not the page's copy: a default model chosen in the
					// picker or an edit of the file meanwhile stays. The watcher may not have seen an edit yet: read it first.
					await opened.reload();
					const next = Object.fromEntries(
						Object.entries({ ...opened.settings, ...changes }).filter(([key]) => !unset.includes(key)),
					);
					await opened.saveSettings(next);
					return null;
				},
			},
		};
	});
});
