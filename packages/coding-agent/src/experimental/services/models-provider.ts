import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	type Conversation,
	type DocumentState,
	type Harness,
} from "@earendil-works/pi-durable";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { Models, type Models as ModelsService, type ModelsState } from "./models.ts";

export interface ModelsServiceRuntime {
	readonly service: ModelsService;
	activate(context: Context): Promise<void>;
	/** Publish the agent document's model and thinking level when they changed. */
	syncConfiguration(context: Context): void;
}

/**
 * The Models service over one conversation. `agent` is the conversation's replicated `pi.agent` document: its
 * configuration follows every change, also those made by other clients.
 */
export function createModelsService(
	conversation: Conversation,
	agent: DocumentState<AgentState>,
	modelRuntime: ModelRuntime | undefined,
	settingsManager: SettingsManager | undefined,
	createState: (initial: ModelsState) => MutableReplicatedState<ModelsState>,
): ModelsServiceRuntime {
	let catalogRevision = 0;
	const configurationOf = (value: Readonly<AgentState> | null): ModelsState["configuration"] => ({
		model: value?.model === undefined ? null : { provider: value.model.provider, modelId: value.model.modelId },
		thinkingLevel: value?.thinkingLevel ?? "off",
	});
	const state = createState({
		catalog: { revision: 0, availableModels: [] },
		configuration: configurationOf(agent.value),
		refresh: { status: "idle" },
	});
	const selectedModel = () => {
		const ref = agent.value?.model;
		return ref === undefined ? undefined : modelRuntime?.getModel(ref.provider, ref.modelId);
	};
	const readThinkingLevels = (): ModelThinkingLevel[] => {
		const selected = selectedModel();
		return selected === undefined ? ["off"] : getSupportedThinkingLevels(selected);
	};
	const readCatalog = (): ModelsState["catalog"] => {
		const selected = selectedModel();
		const available = modelRuntime?.getAvailableSnapshot() ?? [];
		const catalog =
			selected === undefined || includesModel(available, selected) ? available : [...available, selected];
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			availableModels: catalog.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
			})),
		};
	};
	const service: ModelsService = {
		state,
		async cycleThinking(context) {
			const levels = readThinkingLevels();
			const current = agent.value?.thinkingLevel ?? "off";
			const next = levels[(levels.indexOf(current) + 1) % levels.length] ?? "off";
			await conversation.configure({ thinkingLevel: next }, context);
		},
		async getThinkingLevels() {
			return readThinkingLevels();
		},
		async refresh(context) {
			state.change(context, (draft) => {
				draft.refresh = { status: "refreshing" };
			});
			const refresh = modelRuntime?.refresh({ signal: context.abortSignal });
			const errors =
				refresh === undefined
					? {}
					: Object.fromEntries([...(await refresh).errors].map(([id, error]) => [id, error.message]));
			const catalog = readCatalog();
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors };
			});
		},
		async select(model, context) {
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			const thinkingLevel = clampThinkingLevel(selected, agent.value?.thinkingLevel ?? "off");
			await conversation.configure(
				{ model: { provider: selected.provider, modelId: selected.id }, thinkingLevel },
				context,
			);
			settingsManager?.setDefaultModelAndProvider(selected.provider, selected.id);
			await settingsManager?.flush();
		},
		async selectThinking(level, context) {
			const levels = readThinkingLevels();
			if (!levels.includes(level)) {
				throw new Error(`Thinking level ${level} is unavailable; choose one of: ${levels.join(", ")}`);
			}
			await conversation.configure({ thinkingLevel: level }, context);
		},
	};
	return {
		service,
		async activate(context) {
			const catalog = readCatalog();
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.refresh = { status: "idle" };
			});
		},
		syncConfiguration(context) {
			const next = configurationOf(agent.value);
			const current = state.value.configuration;
			if (
				current.model?.provider === next.model?.provider &&
				current.model?.modelId === next.model?.modelId &&
				current.thinkingLevel === next.thinkingLevel
			) {
				return;
			}
			state.change(context, (draft) => {
				draft.configuration = next;
			});
		},
	};
}

/** Acquire the conversation's agent document, then build the facet that owns it. */
export async function createModelsServiceFacet(options: {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly context: Context;
}): Promise<Facet> {
	const agent = await options.harness.documentState(AgentDoc, options.conversation.id, options.context);
	if (agent === undefined) throw new Error(`Conversation ${options.conversation.id} has no agent document`);
	return defineFacet({
		id: "@pi/models",
		setup(env) {
			env.own(() => agent.dispose());
			const runtime = createModelsService(
				options.conversation,
				agent,
				options.modelRuntime,
				options.settingsManager,
				env.replicatedState,
			);
			env.provide(Models, runtime.service);
			env.onActivate(async () => {
				await runtime.activate(BACKGROUND_CONTEXT);
				env.own(agent.subscribe((_value, context) => runtime.syncConfiguration(context)));
			});
		},
	});
}

function includesModel(
	models: readonly { readonly provider: string; readonly id: string }[],
	selected: { readonly provider: string; readonly id: string },
): boolean {
	return models.some((model) => model.provider === selected.provider && model.id === selected.id);
}
