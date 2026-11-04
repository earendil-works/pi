import { arr, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { defineRegistry, local, method, remote, serverHost, unsafe } from "@p2/app/v1";
import type { MobileSettings } from "@p2/app/v1/node";
import type { ResourceSnapshot, Resources } from "./resources.ts";

export type { ResourceSnapshot, Resources } from "./resources.ts";

export const ModelInfoSchema = obj({
	provider: str(),
	modelId: str(),
	name: str(),
	thinkingLevels: arr(str()),
	contextWindow: num(),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

export const ModelChoiceSchema = obj({
	provider: str({ minLength: 1 }),
	modelId: str({ minLength: 1 }),
	thinkingLevel: str({ minLength: 1 }),
});
export type ModelChoice = Static<typeof ModelChoiceSchema>;

export const ScopedModelSchema = obj({
	provider: str(),
	modelId: str(),
	thinkingLevel: opt(str()),
});
export const EnabledModelsSchema = arr(str({ minLength: 1, maxLength: 300 }), { maxItems: 500 });

/** Provider models for the picker and the default for new sessions (owner only). */
export const Models = remote("p2.models", {
	/** 2: `enabledModels`, `scopedModels` and `setEnabledModels` (pi's model scope for cycling). */
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				models: arr(ModelInfoSchema),
				/** Non-secret resource state for the faithful mobile picker and sign-in hint. */
				resources: unsafe<ResourceSnapshot>(unknown()),
				defaultModel: union([ModelChoiceSchema, nul()]),
				errors: arr(str()),
				/** settings.json `enabledModels` patterns (empty: no scope, cycling uses every model). */
				enabledModels: EnabledModelsSchema,
				/** The patterns resolved against `models`, in pattern order (plugins/models/scope.ts). */
				scopedModels: arr(ScopedModelSchema),
			},
			methods: {
				setDefault: method(ModelChoiceSchema),
				/** Saves the patterns to settings.json (an empty list removes the scope). */
				setEnabledModels: method(obj({ patterns: EnabledModelsSchema })),
			},
		},
	},
});

export const ModelSummarySchema = obj({
	models: arr(ModelInfoSchema),
	defaultModel: union([ModelChoiceSchema, nul()]),
	errors: arr(str()),
});

/**
 * The server's configuration resources (host-internal): `settings.json`, `models.json`, `auth.json`, watched and
 * hot-reloaded (p2's Resources). `summary` is what the model picker needs, `snapshot` everything without
 * secrets (settings, signed-in providers, login methods, errors). The observer itself, for plugins that change the
 * configuration (provider login), is `ModelResources`.
 */
export const ModelConfig = local("p2.model-config", {
	version: 2,
	params: {},
	members: {
		summary: ModelSummarySchema,
		snapshot: unsafe<ResourceSnapshot>(unknown()),
		setDefault: method(ModelChoiceSchema),
		setEnabledModels: method(obj({ patterns: EnabledModelsSchema })),
	},
});

/** The server's configuration observer (`ModelConfig` contributes it once open): read `.value?.resources` at each use. */
export const ModelResources = defineRegistry<
	{ readonly resources: Resources },
	{ readonly resources: Resources } | undefined
>("p2.model-resources", { version: 1 });

/** The worker's own configuration observer (host-internal): its current, valid `settings.json`, hot-reloaded. */
export const WorkerModels = local("p2.worker-models", {
	version: 1,
	params: {},
	members: { settings: unsafe<MobileSettings>(unknown()) },
});
