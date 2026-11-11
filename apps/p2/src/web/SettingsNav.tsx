// The Settings window's route and its list of sections. The window is the route's `settings` sheet layer (its locator:
// one of its own sections); a plugin's section is that plugin's sheet layer right above it, which renders as a page of
// the window (src/web/settings-embed.ts). Plugins add their section by contributing to `SettingsSections`.
import { useCallback, useMemo } from "react";
import { getNavigation, type SettingsSection, SettingsSections, useRegistry, useRoute } from "../runtime/web.tsx";
import type { Layer, Route } from "./navigation.ts";
import { useWide } from "./SidePanel.tsx";
import { setSettingsEmbed } from "./settings-embed.ts";

/** The name of the Settings window's layer. */
export const SETTINGS_LAYER = "settings";

/** A section of the Settings window: one of its own (`locator`) or a plugin's sheet (`layer`). */
export type SettingsSectionChoice = { locator: string } | { layer: Layer };

/** Where the Settings window is in `route.layers`; -1 while it is closed. */
export function settingsIndex(route: Route): number {
	return route.layers.findIndex((layer) => layer.kind === "sheet" && layer.name === SETTINGS_LAYER);
}

/**
 * Shows a section of the open Settings window: one of its own (`locator`) or a plugin's sheet (`layer`). Choosing
 * another section beside the list (wide screens) replaces the step; on phones the list is a page of its own, so a
 * section is a new step and Back returns to the list.
 */
export function showSettingsSection(section: SettingsSectionChoice, wide: boolean): void {
	const nav = getNavigation();
	const at = settingsIndex(nav.route);
	if (at < 0) return;
	const layers = [...nav.route.layers.slice(0, at), ...settingsLayers(section)];
	if (wide) void nav.replace({ ...nav.route, layers });
	else void nav.push({ ...nav.route, layers });
}

/**
 * Opens the Settings window in one step, at `section` when given (else the list, or General beside it), over the
 * screen: layers open before it (the drawer) close first, as for any sheet opened from the sidebar.
 */
export function openSettings(section?: SettingsSectionChoice): void {
	void getNavigation().closeThenPush((route) => ({ ...route, layers: settingsLayers(section) }));
}

/** The window's layer showing `section`, with a plugin's sheet layer above it. */
function settingsLayers(section: SettingsSectionChoice | undefined): Layer[] {
	const window: Layer = {
		kind: "sheet",
		name: SETTINGS_LAYER,
		...(section && "locator" in section ? { locator: section.locator } : {}),
	};
	return section && "layer" in section ? [window, section.layer] : [window];
}

/** The section the Settings window shows: a plugin's sheet layer name, its own section's locator, or none (the list). */
export function useSettingsSection(): { kind: "plugin"; name: string } | { kind: "own"; locator?: string } | undefined {
	const route = useRoute();
	const at = settingsIndex(route);
	if (at < 0) return undefined;
	const above = route.layers[at + 1];
	if (above && above.kind !== "drawer") return { kind: "plugin", name: above.name };
	const window = route.layers[at];
	return { kind: "own", locator: window?.kind === "drawer" ? undefined : window?.locator };
}

/** The plugins' sections of the Settings window, keyed by their sheet layer's name, in the list's order. */
export function useSettingsSections(): readonly (readonly [string, SettingsSection])[] {
	const table = useRegistry(SettingsSections);
	return useMemo(
		() => [...table].sort(([a, left], [b, right]) => left.order - right.order || (a < b ? -1 : a > b ? 1 : 0)),
		[table],
	);
}

/**
 * Every plugin section's sheet, always mounted by the app's layout: each renders while the route opens it, as a page of
 * the Settings window or on its own (a session's logs, Sign in to a provider).
 */
export function SettingsSectionSheets() {
	const sections = useSettingsSections();
	return (
		<>
			{sections.map(([name, { Sheet }]) => (
				<Sheet key={name} />
			))}
		</>
	);
}

/** An entry in the Settings window's list of sections that opens the plugin's sheet `name` as a page of the window. */
export function SettingsNavItem({ name, label, title }: { name: string; label: string; title?: string }) {
	const section = useSettingsSection();
	const wide = useWide();
	const current = section?.kind === "plugin" && section.name === name;
	return (
		<button
			type="button"
			className="settings-nav-item"
			aria-current={current ? "page" : undefined}
			title={title}
			onClick={() => showSettingsSection({ layer: { kind: "sheet", name } }, wide)}
		>
			{label}
		</button>
	);
}

/** Phones: from a section back to the Settings window's list of sections. */
function backToSettingsList(): void {
	void getNavigation().close((route) => {
		const at = settingsIndex(route);
		return at < 0
			? route
			: { ...route, layers: [...route.layers.slice(0, at), { kind: "sheet", name: SETTINGS_LAYER }] };
	});
}

/**
 * The Settings window's content pane: every sheet renders here while it is mounted (its own sections' and the plugins'),
 * as a page with its title, and on phones a Back to the list.
 */
export function SettingsPane() {
	const wide = useWide();
	const pane = useCallback(
		(element: HTMLDivElement | null) => {
			setSettingsEmbed(element ? { element, ...(wide ? {} : { back: backToSettingsList }) } : undefined);
		},
		[wide],
	);
	return <div className="settings-pane" ref={pane} />;
}
