// Model and thinking selection in the TUI (p2-tui-port.md section 1.7, P4): pi's model selector, thinking selector
// and scoped models selector as overlays, Shift+Tab thinking cycling and Ctrl+P / Shift+Ctrl+P model cycling over the
// owner's scope (`enabledModels`, else every signed-in model). The model is the owner's choice and cost: `Models` and
// `Chat.configure` are owner-only, so guests get a read-only line. Without a session, a choice sets the default for
// new sessions.

import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, liveIn } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	lineText,
	ModelSelectorComponent,
	type OptimisticAdd,
	ScopedModelsSelectorComponent,
	type SelectorModel,
	ThinkingSelectorComponent,
	type TuiCommand,
	TuiCommands,
	type TuiRuntime,
	TuiScope,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { Chat, type ModelMeta } from "../chat/contract.ts";
import { type ModelChoice, type ModelInfo, Models } from "./contract.ts";

type Scoped = { provider: string; modelId: string; thinkingLevel?: string };

/** A choice in flight: the conversation's model and level, the default, or the scope. */
type Guess = {
	readonly model?: ModelMeta | null;
	readonly thinkingLevel?: string;
	readonly defaultModel?: ModelChoice | null;
	readonly scoped?: Scoped[];
};

/** What the commands read: the state with the choices in flight applied. */
type Shown = {
	readonly model: ModelMeta | null;
	readonly thinkingLevel: string | undefined;
	readonly defaultModel: ModelChoice | null;
	readonly scoped: Scoped[];
};

/**
 * What the commands need, held per runtime (a non-screen slot): the owner's catalog, scope and default, and the viewed
 * conversation's model and thinking level.
 */
export class ModelState implements TuiSurface {
	readonly runtime: TuiRuntime;
	private scope: TuiScope;
	private owner: TuiScope | undefined;
	private chat: TuiScope | undefined;
	private identity: string | undefined;
	private models: Held<typeof Models> | undefined;
	private chatRef: Held<typeof Chat> | undefined;
	/** The state as shown: the choices in flight over what the server last sent. */
	private readonly shownState: () => Shown;
	/** Shows a choice while its call is in flight: the selectors and cycling start from it (Ctrl+P twice moves twice). */
	readonly choosing: OptimisticAdd<Guess>;
	catalog: ModelInfo[] = [];
	private received: Shown = { model: null, thinkingLevel: undefined, defaultModel: null, scoped: [] };
	private stop: () => void;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		this.scope = new TuiScope(runtime);
		[this.shownState, this.choosing] = this.scope.optimistic(
			() => this.received,
			(shown, guess: Guess) => ({ ...shown, ...guess }),
		);
		const changed = (): void => {
			// The catalog is owner-only: guests never request it.
			if (runtime.role === "owner" && !this.owner) {
				this.owner = new TuiScope(runtime);
				this.models = this.owner.watch(Models, {}, (ref, follow) => {
					follow(ref.models, (models) => {
						this.catalog = models ?? [];
					});
					follow(ref.scopedModels, (scoped) => {
						this.received = { ...this.received, scoped: scoped ?? [] };
					});
					follow(ref.defaultModel, (value) => {
						this.received = { ...this.received, defaultModel: value ?? null };
					});
				});
			}
			if (runtime.identity === this.identity) return;
			this.identity = runtime.identity;
			this.chat?.dispose();
			this.chat = undefined;
			this.chatRef = undefined;
			this.received = { ...this.received, model: null, thinkingLevel: undefined };
			const session = runtime.session;
			if (!session) return;
			this.chat = new TuiScope(runtime);
			this.chatRef = this.chat.watch(Chat, { session, conversation: runtime.conversation }, (ref, follow) => {
				follow(ref.model, (model) => {
					this.received = { ...this.received, model: model ?? null };
				});
				follow(ref.view, (view) => {
					const agent = view?.docs["pi.agent"] as { thinkingLevel?: string } | undefined;
					this.received = { ...this.received, thinkingLevel: agent?.thinkingLevel };
				});
			});
		};
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		changed();
	}
	/** The state as shown: the choices in flight over what the server last sent. */
	private get shown(): Shown {
		return this.shownState();
	}
	/** The viewed conversation's model (guest-safe metadata). */
	get model(): ModelMeta | null {
		return this.shown.model;
	}
	get thinkingLevel(): string | undefined {
		return this.shown.thinkingLevel;
	}
	get defaultModel(): ModelChoice | null {
		return this.shown.defaultModel;
	}
	get scoped(): Scoped[] {
		return this.shown.scoped;
	}
	/** The owner's Models reference once live. */
	service(): Held<typeof Models> | undefined {
		return liveIn(this.models, "owner");
	}
	/** The viewed conversation's participant reference once live. */
	participant(): HeldIn<typeof Chat, "participant"> | undefined {
		return liveIn(this.chatRef, "participant");
	}
	selectorModels(): SelectorModel[] {
		return this.catalog.map(({ provider, modelId, name }) => ({ provider, modelId, name }));
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		this.scope.dispose();
		this.owner?.dispose();
		this.chat?.dispose();
	}
}

const STATE_SLOT = "service:models";
const stateOf = (ctx: TuiContext): ModelState | undefined => {
	const surface = ctx.surface(STATE_SLOT);
	return surface instanceof ModelState ? surface : undefined;
};
const describe = (state: ModelState): string =>
	state.model
		? `${lineText(state.model.provider)}/${lineText(state.model.modelId)} · thinking ${lineText(state.thinkingLevel ?? "off")}`
		: "no model";

/** A model and/or level a command chose. */
type Change = { readonly model?: SelectorModel; readonly thinkingLevel?: string };

/** The conversation's model as shown while a change to `model` is in flight: the catalog's facts about it. */
function metaOf(state: ModelState, model: SelectorModel): ModelMeta {
	const info = state.catalog.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId);
	const thinkingLevels = info?.thinkingLevels ?? [];
	return {
		provider: model.provider,
		modelId: model.modelId,
		name: info?.name ?? model.name,
		contextWindow: info?.contextWindow ?? 0,
		reasoning: thinkingLevels.length > 1,
		thinkingLevels,
	};
}

/**
 * Applies a change: the conversation's (Chat.configure) with a session, else the default. The choice shows at once
 * (the notice, and the selectors and cycling start from it); a refused call takes it back and says why.
 */
function choose(ctx: TuiContext, state: ModelState, change: Change, done: string): void {
	if (ctx.identity.session) {
		const chat = state.participant();
		if (!chat) {
			ctx.notify("This conversation is not connected or read-only", "error");
			return;
		}
		const guess = {
			...(change.model ? { model: metaOf(state, change.model) } : {}),
			...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
		};
		ctx.notify(done);
		ctx.perform(
			state.choosing(
				guess,
				chat.configure(
					{
						...(change.model
							? { model: { provider: change.model.provider, modelId: change.model.modelId } }
							: {}),
						...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
					},
					BACKGROUND_CONTEXT,
				),
			),
		);
		return;
	}
	const model = change.model ?? state.defaultModel;
	if (model) setDefault(ctx, state, { ...model, thinkingLevel: change.thinkingLevel }, done);
}

/** Sets the default for new sessions (keeping the default's level unless `thinkingLevel` is given), shown at once. */
function setDefault(
	ctx: TuiContext,
	state: ModelState,
	choice: { provider: string; modelId: string; thinkingLevel: string | undefined },
	done: string,
): void {
	const service = state.service();
	if (!service) {
		ctx.notify("Models are not available", "error");
		return;
	}
	const defaultModel = {
		provider: choice.provider,
		modelId: choice.modelId,
		thinkingLevel: choice.thinkingLevel ?? state.defaultModel?.thinkingLevel ?? "off",
	};
	ctx.notify(done);
	ctx.perform(state.choosing({ defaultModel }, service.setDefault(defaultModel, BACKGROUND_CONTEXT)));
}

/** Guests (and the owner without the catalog yet) see the model read-only. */
function readOnly(ctx: TuiContext, state: ModelState | undefined): boolean {
	if (ctx.role === "owner" && state?.service()) return false;
	ctx.notify(
		state ? `Model: ${describe(state)}${ctx.role === "owner" ? "" : " (only the owner changes it)"}` : "No model",
	);
	return true;
}

function openModelSelector(ctx: TuiContext, initialSearch?: string): void {
	const state = stateOf(ctx);
	if (!state || readOnly(ctx, state)) return;
	const current = ctx.identity.session ? (state.model ?? undefined) : (state.defaultModel ?? undefined);
	const byRef = (ref: Scoped) => state.catalog.find((m) => m.provider === ref.provider && m.modelId === ref.modelId);
	const handle = ctx.overlay(
		"models",
		new ModelSelectorComponent(ctx, {
			title: ctx.identity.session ? undefined : "Choose default model for new sessions",
			models: state.selectorModels(),
			scoped: state.scoped.flatMap((ref) => {
				const model = byRef(ref);
				return model ? [{ provider: model.provider, modelId: model.modelId, name: model.name }] : [];
			}),
			...(current ? { current } : {}),
			...(state.defaultModel ? { defaultModel: state.defaultModel } : {}),
			...(initialSearch ? { initialSearch } : {}),
			onSelect: (model) => {
				handle.close();
				choose(ctx, state, { model }, `Model: ${model.provider}/${model.modelId}`);
			},
			onSelectAsDefault: (model) => {
				handle.close();
				const thinkingLevel = state.thinkingLevel ?? state.defaultModel?.thinkingLevel ?? "off";
				setDefault(ctx, state, { ...model, thinkingLevel }, `Default model: ${model.provider}/${model.modelId}`);
				if (ctx.identity.session) choose(ctx, state, { model }, `Model: ${model.provider}/${model.modelId}`);
			},
			onCancel: () => handle.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

function openThinkingSelector(ctx: TuiContext): void {
	const state = stateOf(ctx);
	if (!state || readOnly(ctx, state)) return;
	const levels = state.model?.thinkingLevels.length ? state.model.thinkingLevels : ["off"];
	const current = state.thinkingLevel ?? state.defaultModel?.thinkingLevel ?? "off";
	const handle = ctx.overlay(
		"thinking",
		new ThinkingSelectorComponent(ctx, {
			current,
			levels,
			...(state.defaultModel ? { defaultLevel: state.defaultModel.thinkingLevel } : {}),
			onSelect: (level) => {
				handle.close();
				choose(ctx, state, { thinkingLevel: level }, `Thinking level: ${level}`);
			},
			onSelectAsDefault: (level) => {
				handle.close();
				const model = state.model ?? state.defaultModel;
				if (!model) return;
				setDefault(ctx, state, { ...model, thinkingLevel: level }, `Default thinking level: ${level}`);
				if (ctx.identity.session) choose(ctx, state, { thinkingLevel: level }, `Thinking level: ${level}`);
			},
			onCancel: () => handle.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

/** pi's Ctrl+P / Shift+Ctrl+P: the next model of the scope (or of every signed-in model), with its scoped level. */
function cycleModel(ctx: TuiContext, direction: 1 | -1): void {
	const state = stateOf(ctx);
	if (!state || readOnly(ctx, state)) return;
	const ring: Scoped[] = state.scoped.length
		? state.scoped
		: state.catalog.map(({ provider, modelId }) => ({ provider, modelId }));
	if (ring.length === 0) return;
	const current = state.model ?? state.defaultModel;
	const index = ring.findIndex((ref) => ref.provider === current?.provider && ref.modelId === current?.modelId);
	const next = ring[(index + direction + ring.length) % ring.length]!;
	const info = state.catalog.find((model) => model.provider === next.provider && model.modelId === next.modelId);
	const model = { provider: next.provider, modelId: next.modelId, name: info?.name ?? next.modelId };
	choose(
		ctx,
		state,
		{ model, ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}) },
		`Model: ${next.provider}/${next.modelId}${next.thinkingLevel ? ` · thinking ${next.thinkingLevel}` : ""}`,
	);
}

/** pi's Shift+Tab: the next of the model's thinking levels. */
function cycleThinking(ctx: TuiContext): void {
	const state = stateOf(ctx);
	if (!state || readOnly(ctx, state)) return;
	const levels = state.model?.thinkingLevels ?? [];
	if (levels.length <= 1) {
		ctx.notify("This model has no thinking levels to cycle");
		return;
	}
	const current = state.thinkingLevel ?? "off";
	const next = levels[(levels.indexOf(current) + 1) % levels.length]!;
	choose(ctx, state, { thinkingLevel: next }, `Thinking level: ${next}`);
}

function openScopedModels(ctx: TuiContext): void {
	const state = stateOf(ctx);
	if (!state || readOnly(ctx, state)) return;
	const handle = ctx.overlay(
		"scoped-models",
		new ScopedModelsSelectorComponent(ctx, {
			models: state.selectorModels(),
			enabled: state.scoped,
			onSave: (patterns) => {
				handle.close();
				const service = state.service();
				if (!service) return;
				ctx.notify(patterns.length ? `Scoped models: ${patterns.length}` : "Model scope cleared");
				// The selector saves exact `provider/modelId` patterns: cycling uses them at once.
				const scoped = patterns.map((pattern) => {
					const slash = pattern.indexOf("/");
					return { provider: pattern.slice(0, slash), modelId: pattern.slice(slash + 1) };
				});
				ctx.perform(state.choosing({ scoped }, service.setEnabledModels({ patterns }, BACKGROUND_CONTEXT)));
			},
			onCancel: () => handle.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

export const MODEL_COMMANDS: Record<string, TuiCommand> = {
	"app.model.select": {
		title: "Select model",
		category: "Model",
		when: "!overlay",
		slash: {
			name: "model",
			argumentHint: "[provider/model]",
			complete: (prefix, ctx) => {
				const state = stateOf(ctx);
				const lower = prefix.toLowerCase();
				return (state?.catalog ?? [])
					.map((model) => `${model.provider}/${model.modelId}`)
					.filter((ref) => ref.toLowerCase().includes(lower))
					.slice(0, 30)
					.map((ref) => ({ value: ref, label: ref }));
			},
		},
		run: (ctx, args) => {
			const state = stateOf(ctx);
			const query = args?.trim();
			// pi: `/model provider/id` switches at once when it names exactly one model.
			const exact = query
				? state?.catalog.find((model) => `${model.provider}/${model.modelId}`.toLowerCase() === query.toLowerCase())
				: undefined;
			if (state && exact && !readOnly(ctx, state))
				choose(ctx, state, { model: exact }, `Model: ${exact.provider}/${exact.modelId}`);
			else if (!exact) openModelSelector(ctx, query);
		},
	},
	"app.model.cycleForward": {
		title: "Cycle to next model",
		category: "Model",
		when: "chat && !overlay",
		run: (ctx) => cycleModel(ctx, 1),
	},
	"app.model.cycleBackward": {
		title: "Cycle to previous model",
		category: "Model",
		when: "chat && !overlay",
		run: (ctx) => cycleModel(ctx, -1),
	},
	"app.thinking.cycle": {
		title: "Cycle thinking level",
		category: "Model",
		when: "chat && !overlay && !autocomplete",
		run: (ctx) => cycleThinking(ctx),
	},
	"p2.thinking.select": {
		title: "Select thinking level",
		category: "Model",
		when: "!overlay",
		slash: { name: "thinking" },
		run: (ctx) => openThinkingSelector(ctx),
	},
	"p2.models.scope": {
		title: "Scoped models for cycling",
		category: "Model",
		when: "owner && !overlay",
		slash: { name: "scoped-models" },
		run: (ctx) => openScopedModels(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-models", (self) => {
		self.contribute(TuiSlots, { [STATE_SLOT]: (runtime: TuiRuntime): TuiSurface => new ModelState(runtime) });
		self.contribute(TuiCommands, MODEL_COMMANDS);
	}),
);
