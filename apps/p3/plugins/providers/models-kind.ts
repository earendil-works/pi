// The model settings kind (`providers.models`, decision 118b): overrides of models' metadata (names, costs, limits,
// thinking levels, hidden), layered over every login a session may use, the nearest thing winning per field (every
// one that reaches a session counts, merged in `SessionModels`). Made by people; linked in any number of workspaces.
// Its ticks: Use (agents only, a flag: the session's agent gets its overrides), and Edit (for all), which gives `set`,
// a change of its overrides: an agent may change model settings, never a login's endpoint (decision 118d through a
// tick of its own, not the workspace's Configure, which reaches every thing linked there; decision 124, main session,
// reversible). A new link gives the agents Use and Edit and everyone Edit; its overrides are for everyone let in.

import { arr, method, obj } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { ModelOverride } from "./contract.ts";
import { messages } from "./messages.ts";

/** What Edit gives: the members a model settings thing's editor is granted. */
export const MODEL_SETTINGS_WRITES = ["set"] as const;

/**
 * A model settings thing: its `overrides` (for everyone let in) and `set` (Edit), which replaces them, as `configure`
 * does for a person with Configure where it is linked.
 */
export const ModelSettingsKind = defineThing("providers.models", {
	version: 1,
	makers: "people",
	state: { overrides: arr(ModelOverride) },
	methods: {
		/** Replaces its overrides. */
		set: method(obj({ overrides: arr(ModelOverride) })),
	},
	ticks: {
		// `overrides`, which no tick gives, is for everyone let in: reading.
		use: { label: messages.message("tickUseModelSettings"), for: "agents" },
		edit: { label: messages.message("tickEditModelSettings"), gives: MODEL_SETTINGS_WRITES },
	},
	defaultGrants: { agents: ["use", "edit"], everyone: ["edit"] },
	settings: ["overrides"],
});

/** One model settings thing held in a workspace: `ModelSettingsKind`'s contract. */
export const ModelSettings = ModelSettingsKind.contract;
