// The model choice and actions of the conversation screens on the page, by the command menu target each shows: the
// menu's model pages and commands read and change a target's model through the screen that shows it, so they see the
// choice the footer shows (its optimistic guess included) and a change shows there at once, instead of when the
// conversation reports it.
import type { CommandTarget, ModelChoice } from "@p2/app/v1/web";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/** What a screen shows of the conversation's model and does with a change. */
export type ModelScreen = {
	/** The choice the screen shows (absent: not known yet). */
	readonly choice: ModelChoice | undefined;
	/** Applies `choice` to the conversation (the session the new-session screen starts). */
	readonly choose: (choice: ModelChoice) => void;
	/** Saves the screen's choice as the default for new sessions. */
	readonly makeDefault: () => void;
};

type Actions = Omit<ModelScreen, "choice">;

const screens = new Map<string, ModelScreen>();
const listeners = new Set<() => void>();

/**
 * Registers the screen showing `target` while it is mounted (no target: a read-only screen). Its entry changes when
 * the choice does, not with every render of the screen: the actions are read from the latest render when called.
 */
export function useModelScreen(target: CommandTarget | undefined, choice: ModelChoice | undefined, actions: Actions) {
	const latest = useRef(actions);
	useLayoutEffect(() => {
		latest.current = actions;
	});
	const key = target && keyOf(target);
	const shown = choice && `${choice.model.provider}\n${choice.model.modelId}\n${choice.thinkingLevel}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: shown holds choice by value; screens pass a new object each render.
	useEffect(() => {
		if (key === undefined) return;
		const entry: ModelScreen = {
			choice,
			choose: (next) => latest.current.choose(next),
			makeDefault: () => latest.current.makeDefault(),
		};
		screens.set(key, entry);
		changed();
		return () => {
			if (screens.get(key) !== entry) return;
			screens.delete(key);
			changed();
		};
	}, [key, shown]);
}

/** The screen showing `target`, if one is mounted, re-rendering when it changes. */
export function useShownModelScreen(target: CommandTarget | undefined): ModelScreen | undefined {
	return useSyncExternalStore(subscribe, () => (target ? modelScreen(target) : undefined));
}

/** The screen showing `target`, if one is mounted (for an action, outside render). */
export const modelScreen = (target: CommandTarget): ModelScreen | undefined => screens.get(keyOf(target));

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function changed(): void {
	for (const listener of listeners) listener();
}

const keyOf = (target: CommandTarget): string => `${target.type}\n${target.id}`;
