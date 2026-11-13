// The command menu's route layers: the menu is the route's trailing run of `commands` sheet layers, the root first
// (its locator holds the target captured when the menu opened) and one more per open page. Read back as untrusted.

import { getNavigation } from "../../runtime/web.tsx";
import type { CommandTarget } from "../../runtime/web-core.ts";
import type { Layer, Route } from "../navigation.ts";

/** The open menu as its layers say: the captured target and the names of the pages opened on top of the root. */
export type OpenMenu = {
	readonly target: CommandTarget | undefined;
	/** One per page layer; `undefined` for a locator that does not name a page. */
	readonly pages: readonly (string | undefined)[];
};

const NAME = "commands";

/** The open menu, when the route's top layer is one of its layers. */
export function openMenu(route: Route): OpenMenu | undefined {
	const start = menuStart(route.layers);
	const [root, ...pages] = route.layers.slice(start).map((layer) => parse(layer));
	if (root === undefined) return undefined;
	return { target: root.target, pages: pages.map((page) => page?.page) };
}

/** Opens the menu on the current route, with `target` captured in its root layer. */
export function pushMenu(target: CommandTarget | undefined): void {
	const nav = getNavigation();
	void nav.push({ ...nav.route, layers: [...nav.route.layers, rootLayer(target)] });
}

/** Closes the menu: removes its layers and nothing under them (a sheet the menu opened over stays). */
export function closeMenu(): Promise<void> {
	return getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, menuStart(route.layers)) }));
}

/** Opens the page `name` on top of the menu's layers. */
export function pushMenuPage(name: string): void {
	const nav = getNavigation();
	const page: Layer = { kind: "sheet", name: NAME, locator: JSON.stringify({ page: name }) };
	void nav.push({ ...nav.route, layers: [...nav.route.layers, page] });
}

/** Goes up one page; from the root it closes the menu. */
export function popMenu(): Promise<void> {
	return getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, -1) }));
}

/** Drops the captured target from the menu's root layer, in place (no history step). */
export function dropMenuTarget(): Promise<void> {
	const nav = getNavigation();
	const start = menuStart(nav.route.layers);
	const layers = nav.route.layers.map((layer, index) => (index === start ? rootLayer(undefined) : layer));
	return nav.replace({ ...nav.route, layers });
}

/** Where the trailing run of menu layers starts in `layers` (`layers.length` when the menu is closed). */
function menuStart(layers: readonly Layer[]): number {
	let start = layers.length;
	while (start > 0 && isMenuLayer(layers[start - 1]!)) start--;
	return start;
}

const isMenuLayer = (layer: Layer): boolean => layer.kind === "sheet" && layer.name === NAME;

const rootLayer = (target: CommandTarget | undefined): Layer => ({
	kind: "sheet",
	name: NAME,
	locator: JSON.stringify(target ? { target } : {}),
});

type Locator = { readonly target?: CommandTarget; readonly page?: string };

// Locators come back from history and session storage: anything this module did not write reads as empty.
function parse(layer: Layer): Locator {
	if (layer.kind !== "sheet" || layer.locator === undefined) return {};
	try {
		const value: unknown = JSON.parse(layer.locator);
		if (typeof value !== "object" || value === null) return {};
		const { target, page } = value as { target?: unknown; page?: unknown };
		return {
			...(isTarget(target) ? { target } : {}),
			...(typeof page === "string" ? { page } : {}),
		};
	} catch {
		return {};
	}
}

function isTarget(value: unknown): value is CommandTarget {
	if (typeof value !== "object" || value === null) return false;
	const { type, id, kind, label } = value as Record<string, unknown>;
	return typeof type === "string" && typeof id === "string" && typeof kind === "string" && typeof label === "string";
}
