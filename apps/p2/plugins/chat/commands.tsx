// The chat's model commands for the command menu: Change model… and Thinking level… on a
// session, a subagent's conversation or the new-session screen, and Set default model…, with their pages.
import { BACKGROUND_CONTEXT, type Host, keptIn, withHeld } from "@p2/app/v1";
import {
	type Command,
	CommandMenu,
	type CommandPage,
	type ModelChoice,
	ModelIcon,
	matchingModels,
	modelChoice,
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

/** The pages, by name. */
export const MODEL_PAGES: Readonly<Record<string, CommandPage>> = {
	models: { label: "Models", placeholder: "Search models…", Body: ModelsPage },
	thinking: { label: "Thinking level", placeholder: "Search levels…", Body: ThinkingPage },
	"default-model": { label: "Default model", placeholder: "Search models…", Body: DefaultModelPage },
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
				const { model: chosen, thinkingLevel } = modelChoice(model, settings?.thinkingLevel);
				await withHeld(host.hold(Models, {}, BACKGROUND_CONTEXT), "owner", (models) =>
					models.setDefault({ ...chosen, thinkingLevel }, BACKGROUND_CONTEXT),
				).catch(fail);
			}}
		/>
	);
}

/** The owner's model catalog and settings. */
const useResources = (): ResourceSnapshot | undefined => useReadable(useObject(Models, {})?.resources);

type Model = ResourceSnapshot["models"][number];

/** As many models as the model sheet lists at most. */
const MODEL_ROWS = 300;

/** The signed-in models matching the page's query, with their provider; `current`'s model is checked. */
function ModelRows({
	resources,
	current,
	onPick,
}: {
	resources: ResourceSnapshot | undefined;
	current: Pick<ModelChoice, "model"> | undefined;
	onPick: (model: Model) => void;
}) {
	const models = useMemo(() => matchingModels(resources, ""), [resources]);
	const providers = useMemo(
		() => new Map(resources?.providers.map((provider) => [provider.id, provider.name])),
		[resources],
	);
	const text = useCallback(
		(model: Model) => `${model.name} ${model.modelId} ${providers.get(model.provider) ?? model.provider}`,
		[providers],
	);
	const matches = useCommandMatches(models, text);
	return (
		<CommandMenu.Group heading="Models">
			{matches.slice(0, MODEL_ROWS).map((model) => (
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
 * The menu's target as a model change sees it: a session's main conversation, a subagent's conversation (each through
 * `Chat.configure`), or the session the new-session screen is about to start (its choice there).
 */
function useModelTarget(resources: ResourceSnapshot | undefined): ModelTarget | undefined {
	const target = useCommandTarget();
	const host = useHost();
	const sessions = useCatalog();
	const children = useReadable(keptIn(useObject(Subagents, {}), "reader")?.children);
	const { choice: selected, setChoice } = useNewSessionState();
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
async function configure(host: Host, session: string, conversation: number, choice: ModelChoice): Promise<void> {
	const chat = host.hold(Chat, { session, conversation }, BACKGROUND_CONTEXT);
	await withHeld(chat, "participant", (live) => live.configure(choice, BACKGROUND_CONTEXT));
}
