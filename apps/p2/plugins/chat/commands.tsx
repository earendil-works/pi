// The chat's model commands for the command menu: Change model…, Thinking level… and Set current model as default on
// a session, a subagent's conversation or the new-session screen, and Set default model…, with their pages. The
// footer's model and thinking links open the same pages (web.tsx).
import { BACKGROUND_CONTEXT, type Host, keptIn, withHeld } from "@p2/app/v1";
import {
	type Command,
	CommandMenu,
	type CommandPage,
	type CommandTarget,
	type ModelChoice,
	ModelIcon,
	modelChoice,
	signedInModels,
	ThinkingIcon,
	thinkingLevels,
	useCommandMatches,
	useCommandMenu,
	useCommandTarget,
	useComposerState,
	useHost,
	useNewSessionState,
	useObject,
	useReadable,
} from "@p2/app/v1/web";
import { type ReactNode, useCallback, useMemo } from "react";
import { Models, type ResourceSnapshot } from "../models/contract.ts";
import { type Session, Sessions } from "../sessions/contract.ts";
import { type Child, modelRefOf, Subagents } from "../subagents/contract.ts";
import { Chat, conversationOf } from "./contract.ts";
import { newSessionChoice, thinkingLevelOf } from "./model-choice.ts";
import { modelScreen, useShownModelScreen } from "./model-screens.ts";

/** The targets a model change applies to: a session (its main conversation), a subagent's conversation, a new session. */
const MODEL_TARGETS = ["session", "conversation", "new-session"];

/** The commands, by id. */
export const MODEL_COMMANDS: Readonly<Record<string, Command>> = {
	"chat.change-model": {
		title: "Change model…",
		group: "Model",
		order: 20,
		icon: ModelIcon,
		keywords: ["switch model"],
		target: MODEL_TARGETS,
		owner: true,
		Shown: Configurable,
		action: { kind: "page", page: "models" },
	},
	"chat.thinking-level": {
		title: "Thinking level…",
		group: "Model",
		order: 20,
		icon: ThinkingIcon,
		keywords: ["reasoning", "effort"],
		target: MODEL_TARGETS,
		owner: true,
		Shown: Configurable,
		action: { kind: "page", page: "thinking" },
	},
	"chat.make-default": {
		title: "Set current model as default",
		group: "Model",
		order: 20,
		icon: ModelIcon,
		keywords: ["thinking level", "make default"],
		target: MODEL_TARGETS,
		owner: true,
		action: { kind: "run", run: ({ host, target }) => makeCurrentDefault(host, target) },
	},
	"chat.set-default-model": {
		title: "Set default model…",
		group: "Model",
		order: 20,
		icon: ModelIcon,
		keywords: ["default for new sessions"],
		owner: true,
		action: { kind: "page", page: "default-model" },
	},
};

/** What a model page says while it lists nothing: the pages list signed-in providers' models only. */
const NO_MODELS = "No models match. Only signed-in providers are listed.";

/** The pages, by name. */
export const MODEL_PAGES: Readonly<Record<string, CommandPage>> = {
	models: { label: "Models", placeholder: "Search models…", empty: NO_MODELS, Body: ModelsPage },
	thinking: { label: "Thinking level", placeholder: "Search levels…", Body: ThinkingPage },
	"default-model": { label: "Default model", placeholder: "Search models…", empty: NO_MODELS, Body: DefaultModelPage },
};

/**
 * Renders `children` unless the target is a session that is archived or not known yet: an archived session's worker
 * does not start, so its model cannot change. Conversation and new-session targets always show them.
 */
function Configurable({ children }: { children: ReactNode }) {
	const target = useCommandTarget();
	const session = useCatalog()?.find((each) => each.id === target?.id);
	return target?.type !== "session" || session?.archivedAt === null ? children : null;
}

/**
 * Saves the target's model and thinking level as the default for new sessions: through the screen showing it (its
 * footer shows the change at once), else, for a session's row in the sidebar, as the catalog says. Conversation and
 * new-session targets come only from their screens.
 */
async function makeCurrentDefault(host: Host, target: CommandTarget | undefined): Promise<void> {
	const screen = target && modelScreen(target);
	if (screen) return screen.makeDefault();
	if (target?.type !== "session") return;
	const session = await withHeld(host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner", async (catalog) =>
		catalog.sessions.value.find((each) => each.id === target.id),
	);
	if (session) await setDefault(host, { model: session.model, thinkingLevel: thinkingLevelOf(session.thinkingLevel) });
}

/** The owner's catalog rows (kept while reconnecting). */
const useCatalog = (): readonly Session[] | undefined =>
	useReadable(keptIn(useObject(Sessions, {}), "owner")?.sessions);

/** The target's model; picking another applies it with the thinking level kept where the model has it, else off. */
function ModelsPage() {
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const resources = useResources();
	const target = useModelTarget(resources);
	if (!target) return null;
	return (
		<ModelRows
			resources={resources}
			current={target.choice}
			onPick={async (model) => {
				await close();
				await target.apply(modelChoice(model, target.choice?.thinkingLevel)).catch(fail);
			}}
		/>
	);
}

/** The thinking levels of the target's model, its current one checked. */
function ThinkingPage() {
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const resources = useResources();
	const target = useModelTarget(resources);
	const choice = target?.choice;
	const levels = useMemo(() => thinkingLevels(resources, choice?.model), [resources, choice?.model]);
	const matches = useCommandMatches(levels, levelText);
	if (!target || !choice) return null;
	return (
		<CommandMenu.Group heading="Thinking level">
			{matches.map((level) => (
				<CommandMenu.Row
					key={level}
					title={level}
					checked={level === choice.thinkingLevel}
					onSelect={async () => {
						await close();
						await target.apply({ ...choice, thinkingLevel: thinkingLevelOf(level) }).catch(fail);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}

const levelText = (level: string): string => level;

/** The default model for new sessions, checked; picking another keeps the default thinking level where it can. */
function DefaultModelPage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const resources = useResources();
	const settings = resources?.settings;
	const current = settings?.defaultModel && { model: settings.defaultModel };
	return (
		<ModelRows
			resources={resources}
			current={current}
			onPick={async (model) => {
				await close();
				await setDefault(host, modelChoice(model, settings?.thinkingLevel)).catch(fail);
			}}
		/>
	);
}

/** Saves `choice` as the default for new sessions. */
async function setDefault(host: Host, choice: ModelChoice): Promise<void> {
	await withHeld(host.hold(Models, {}, BACKGROUND_CONTEXT), "owner", (models) =>
		models.setDefault({ ...choice.model, thinkingLevel: choice.thinkingLevel }, BACKGROUND_CONTEXT),
	);
}

/** The owner's model catalog and settings. */
const useResources = (): ResourceSnapshot | undefined => useReadable(useObject(Models, {})?.resources);

type Model = ResourceSnapshot["models"][number];

/** As many models as a page lists at most. */
const MODEL_ROWS = 300;

/**
 * The signed-in models matching the page's query, with their provider; `current`'s model is checked. The models of
 * `current`'s provider come first (each part best match first, ties in the catalog's order): searching "sonnet" while on
 * Anthropic lists Anthropic's before Bedrock's, whose names are the same. Every word must match, so this only reorders
 * matches; a query naming another provider lists that provider's models alone.
 */
function ModelRows({
	resources,
	current,
	onPick,
}: {
	resources: ResourceSnapshot | undefined;
	current: Pick<ModelChoice, "model"> | undefined;
	onPick: (model: Model) => void;
}) {
	const models = useMemo(() => signedInModels(resources), [resources]);
	const providers = useMemo(
		() => new Map(resources?.providers.map((provider) => [provider.id, provider.name])),
		[resources],
	);
	const text = useCallback(
		(model: Model) => `${model.name} ${model.modelId} ${providers.get(model.provider) ?? model.provider}`,
		[providers],
	);
	const matches = useCommandMatches(models, text);
	const provider = current?.model.provider;
	const ordered = useMemo(
		() => [
			...matches.filter((model) => model.provider === provider),
			...matches.filter((model) => model.provider !== provider),
		],
		[matches, provider],
	);
	return (
		<CommandMenu.Group heading="Models">
			{ordered.slice(0, MODEL_ROWS).map((model) => (
				<CommandMenu.Row
					key={`${model.provider}/${model.modelId}`}
					title={model.name}
					suffix={providers.get(model.provider) ?? model.provider}
					checked={current?.model.provider === model.provider && current.model.modelId === model.modelId}
					onSelect={() => onPick(model)}
				/>
			))}
		</CommandMenu.Group>
	);
}

/** What a model change applies to: the choice it has now (absent: not known yet) and how to apply another. */
type ModelTarget = {
	readonly choice: ModelChoice | undefined;
	readonly apply: (choice: ModelChoice) => Promise<void>;
};

/**
 * The menu's target as a model change sees it: the screen showing it (`useModelScreen`: the session's main
 * conversation, a subagent's conversation, the new-session screen), whose footer shows the change at once; else a
 * session's row in the sidebar (through `Chat.configure`).
 */
function useModelTarget(resources: ResourceSnapshot | undefined): ModelTarget | undefined {
	const target = useCommandTarget();
	const host = useHost();
	const screen = useShownModelScreen(target);
	const sessions = useCatalog();
	const children = useReadable(keptIn(useObject(Subagents, {}), "reader")?.children);
	const { choice: selected, setChoice } = useNewSessionState();
	if (screen) return { choice: screen.choice, apply: async (choice) => screen.choose(choice) };
	switch (target?.type) {
		case "new-session": {
			const latest = sessions?.reduce<Session | undefined>(
				(found, session) => (found && found.updatedAt >= session.updatedAt ? found : session),
				undefined,
			);
			return { choice: newSessionChoice(selected, resources, latest), apply: async (choice) => setChoice(choice) };
		}
		case "session": {
			const session = sessions?.find((each) => each.id === target.id);
			if (!session) return undefined;
			return {
				choice: { model: session.model, thinkingLevel: thinkingLevelOf(session.thinkingLevel) },
				apply: (choice) => configure(host, session.id, session.main, choice),
			};
		}
		case "conversation": {
			const at = conversationOf(target.id);
			const child = at && children?.[at.session]?.find((each) => each.conversationId === at.conversation);
			if (!at || !child) return undefined;
			return { choice: childChoice(child), apply: (choice) => configure(host, at.session, at.conversation, choice) };
		}
		default:
			return undefined;
	}
}

/** A subagent's model as it reports it (`provider/modelId`, the model ID may hold more slashes). */
function childChoice(child: Child): ModelChoice | undefined {
	const model = modelRefOf(child.model);
	return model && { model, thinkingLevel: thinkingLevelOf(child.thinkingLevel) };
}

/** Sets the model of a conversation (its worker starts if it is not running). */
export async function configure(host: Host, session: string, conversation: number, choice: ModelChoice): Promise<void> {
	const chat = host.hold(Chat, { session, conversation }, BACKGROUND_CONTEXT);
	await withHeld(chat, "participant", (live) => live.configure(choice, BACKGROUND_CONTEXT));
}
