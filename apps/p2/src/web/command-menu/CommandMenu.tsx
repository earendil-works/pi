// The command menu (Cmd+K): the provider (the target sources and the key that opens it), the
// frame (the dialog while the route's top layer is the menu's), and the parts plugins compose pages and searches with.
import "./command-menu.css";
import {
	type MouseEvent,
	type ReactNode,
	useDeferredValue,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { Commands, getNavigation, useHost, useRegistry, useRoute, useShownModal } from "../../runtime/web.tsx";
import { useComposerState } from "../composer-state.tsx";
import { type CommandMenuActions, CommandMenuContext, type CommandMenuMeta, type CommandMenuValue } from "./context.ts";
import { Input, Target } from "./Header.tsx";
import { matchesBinding } from "./keys.ts";
import { List, Status } from "./List.tsx";
import { closeMenu, dropMenuTarget, type OpenMenu, openMenu, popMenu, pushMenu, pushMenuPage } from "./layers.ts";
import { Group, Row } from "./parts.tsx";
import { recordRecent } from "./recents.ts";
import { CommandTargetsContext, currentTarget, type TargetSources } from "./targets.ts";

/**
 * Mounted once around the app's layout: holds where the target comes from (targets.ts) and listens for Cmd+K (Ctrl+K
 * off macOS), which opens the menu with the target of that moment or closes it. A key a focused component consumed
 * first (the terminal's Ctrl+K) and keys of an input method composing are left alone.
 */
function Provider({ children }: { children: ReactNode }) {
	const [sources] = useState<TargetSources>(() => ({}));
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.repeat || !matchesBinding(event, "p2.commands.open"))
				return;
			event.preventDefault();
			if (openMenu(getNavigation().route)) void closeMenu();
			else pushMenu(currentTarget(sources));
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [sources]);
	return <CommandTargetsContext value={sources}>{children}</CommandTargetsContext>;
}

/** The menu's dialog while the route's top layer is one of the menu's layers. */
function Frame() {
	const route = useRoute();
	const menu = useMemo(() => openMenu(route), [route]);
	return menu ? <Dialog menu={menu} /> : null;
}

/**
 * The open menu: scrim, panel, header, list. It owns the queries, one per open layer, so going back restores a page's
 * text; they go when the menu closes. Focus moves to the input on open, stays there (a press anywhere else in the
 * panel keeps it) and returns on close to the element that had it, else the composer.
 */
function Dialog({ menu }: { menu: OpenMenu }) {
	useShownModal();
	const host = useHost();
	const commands = useRegistry(Commands);
	const { fail } = useComposerState();
	const depth = menu.pages.length;
	const [queries, setQueries] = useState<readonly string[]>([]);
	const query = queries[depth] ?? "";
	// The list follows the deferred query; on a page change it takes that page's at once, not the previous page's, and
	// after an Enter (`settle`) the input's.
	const typed = useMemo(() => ({ depth, query }), [depth, query]);
	const deferred = useDeferredValue(typed);
	const [settled, setSettled] = useState<string>();
	const listQuery = deferred.depth !== depth || settled === query ? query : deferred.query;
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const { target } = menu;

	const actions = useMemo<CommandMenuActions>(() => {
		const openPage = (name: string) => {
			setQueries((current) => current.slice(0, depth + 1));
			pushMenuPage(name);
		};
		return {
			close: closeMenu,
			openPage,
			back: () => void popMenu(),
			removeTarget: () => void dropMenuTarget(),
			run: async (id) => {
				const command = commands.get(id);
				if (command === undefined) return;
				recordRecent(id);
				const { action } = command;
				if (action.kind === "page") return openPage(action.page);
				// The command's own navigation computes its route from the current one: after the close, not under it.
				await closeMenu();
				try {
					await action.run({ host, route: getNavigation().route, ...(target ? { target } : {}) });
				} catch (error) {
					fail(error);
				}
			},
		};
	}, [commands, host, fail, target, depth]);

	const meta = useMemo<CommandMenuMeta>(
		() => ({ list, listId, settle: (text) => flushSync(() => setSettled(text)) }),
		[listId],
	);
	const value = useMemo<CommandMenuValue>(
		() => ({ state: { target, pages: menu.pages, query: listQuery }, actions, meta }),
		[target, menu.pages, listQuery, actions, meta],
	);

	const setQuery = (text: string) =>
		setQueries((current) =>
			Array.from({ length: depth + 1 }, (_, index) => (index === depth ? text : (current[index] ?? ""))),
		);

	useLayoutEffect(() => {
		const previous = document.activeElement;
		input.current?.focus();
		return () => {
			const back =
				previous instanceof HTMLElement && previous.isConnected
					? previous
					: document.querySelector<HTMLElement>(".composer textarea");
			back?.focus({ preventScroll: true });
		};
	}, []);

	const keepFocus = (event: MouseEvent) => {
		if (event.target !== input.current) event.preventDefault();
	};

	return createPortal(
		<CommandMenuContext value={value}>
			<div className="sheet-layer command-layer">
				<button type="button" className="scrim" aria-label="Close" tabIndex={-1} onClick={() => void closeMenu()} />
				<section
					className="command-menu"
					role="dialog"
					aria-modal="true"
					aria-label="Command menu"
					onMouseDown={keepFocus}
				>
					<Target />
					<Input ref={input} query={query} onQuery={setQuery} />
					<List />
					<Status />
				</section>
			</div>
		</CommandMenuContext>,
		document.body,
	);
}

/** The command menu's parts: `Provider` and `Frame` for the app's layout, `Group` and `Row` for pages and searches. */
export const CommandMenu = { Provider, Frame, Group, Row };
