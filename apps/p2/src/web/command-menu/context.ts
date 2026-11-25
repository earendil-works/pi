// The open command menu's context: what its parts and the plugins' pages, searches and `Shown` wrappers read.
import { createContext, type RefObject, use } from "react";
import type { CommandTarget } from "../../runtime/web-core.ts";

export type CommandMenuState = {
	/** The target captured when the menu opened; gone once the reader removed it. */
	readonly target: CommandTarget | undefined;
	/** The names of the pages open on top of the root, the open one last (see `OpenMenu`). */
	readonly pages: readonly (string | undefined)[];
	/** The open page's query, deferred: lists filter by it while the input shows every keystroke at once. */
	readonly query: string;
};

export type CommandMenuActions = {
	/** Closes the menu; resolves once its layers are gone, so what runs next sees the route under it. */
	close(): Promise<void>;
	/** Opens one of `CommandPages` on top of the open page. */
	openPage(name: string): void;
	/** Goes up one page (from the root: closes the menu). */
	back(): void;
	/** Drops the target chip. */
	removeTarget(): void;
	/** Runs the command `id` as the menu does: records it as recent, then opens its page or closes and runs it. */
	run(id: string): Promise<void>;
};

export type CommandMenuMeta = {
	/** The listbox, observed for its options (the highlight, the result count). */
	readonly list: RefObject<HTMLDivElement | null>;
	readonly listId: string;
	/** Renders the list for `query` (the input's) at once, when it still shows the deferred one: Enter acts on it. */
	readonly settle: (query: string) => void;
};

export type CommandMenuValue = {
	readonly state: CommandMenuState;
	readonly actions: CommandMenuActions;
	readonly meta: CommandMenuMeta;
};

/** Provided by the menu's dialog while it is open. */
export const CommandMenuContext = createContext<CommandMenuValue | undefined>(undefined);

/** The open menu's context; throws outside it (its parts and pages render only inside the open menu). */
export function useCommandMenuValue(): CommandMenuValue {
	const value = use(CommandMenuContext);
	if (value === undefined) throw new Error("command menu parts render inside the open command menu");
	return value;
}

/** The open menu's actions: a page's row closes it (`await close()`) before it navigates or changes something. */
export const useCommandMenu = (): CommandMenuActions => useCommandMenuValue().actions;

/** The target the open menu acts on. */
export const useCommandTarget = (): CommandTarget | undefined => useCommandMenuValue().state.target;

/** The open page's query (deferred). */
export const useCommandQuery = (): string => useCommandMenuValue().state.query;
