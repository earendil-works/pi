// Where the command menu finds its target when it opens: the row under the mouse, else the focused row, else what the
// main area shows. Rows and views write them as plain fields (nothing re-renders); Cmd+K reads them once.
import { createContext, use, useEffect } from "react";
import type { CommandTarget } from "../../runtime/web-core.ts";

/** The candidates, written by target rows and the main area's view; read only when the menu opens. */
export type TargetSources = { hovered?: CommandTarget; focused?: CommandTarget; route?: CommandTarget };

/** Provided once by `CommandMenu.Provider`, around the whole layout; the value never changes. */
export const CommandTargetsContext = createContext<TargetSources | undefined>(undefined);

/** The target the menu captures as it opens, by priority: hovered, focused, the route's. */
export const currentTarget = (sources: TargetSources): CommandTarget | undefined =>
	sources.hovered ?? sources.focused ?? sources.route;

/**
 * Registers what the main area shows (the open session, a subagent's conversation, the new-session screen) as the
 * menu's target while mounted. One view at a time calls it: the main area shows one.
 */
export function useCommandRouteTarget(target: CommandTarget | undefined): void {
	const sources = useTargetSources();
	const key = target && `${target.type}\n${target.id}\n${target.kind}\n${target.label}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: key holds target by value; views pass a new object each render.
	useEffect(() => {
		if (target === undefined) return;
		sources.route = target;
		return () => {
			if (sources.route === target) sources.route = undefined;
		};
	}, [sources, key]);
}

/** The handlers a row spreads to be the menu's target while the mouse is over it or it has focus. */
export type CommandTargetRow = {
	readonly onPointerEnter: () => void;
	readonly onPointerLeave: () => void;
	readonly onFocus: () => void;
	readonly onBlur: () => void;
};

/** Makes a row (a sidebar session) the menu's target while hovered or focused; a row that unmounts lets go. */
export function useCommandTargetRow(target: CommandTarget): CommandTargetRow {
	const sources = useTargetSources();
	const { type, id } = target;
	useEffect(
		() => () => {
			if (same(sources.hovered, type, id)) sources.hovered = undefined;
			if (same(sources.focused, type, id)) sources.focused = undefined;
		},
		[sources, type, id],
	);
	return {
		onPointerEnter: () => {
			sources.hovered = target;
		},
		onPointerLeave: () => {
			if (same(sources.hovered, type, id)) sources.hovered = undefined;
		},
		onFocus: () => {
			sources.focused = target;
		},
		onBlur: () => {
			if (same(sources.focused, type, id)) sources.focused = undefined;
		},
	};
}

/** The target sources of `CommandMenu.Provider`; throws outside it. */
function useTargetSources(): TargetSources {
	const sources = use(CommandTargetsContext);
	if (sources === undefined) throw new Error("command targets need CommandMenu.Provider");
	return sources;
}

const same = (target: CommandTarget | undefined, type: string, id: string): boolean =>
	target?.type === type && target.id === id;
