// Per-browser colour theme, chosen in the sidebar. "system" follows
// prefers-color-scheme. The resolved theme is always written to
// <html data-theme>, which style.css keys off. The page's inline script (src/hosts/web.ts) sets the attribute
// before styles load (no flash) from the same key.

export type ThemePreference = "system" | "light" | "dark";

const KEY = "pi-theme";
// Must match --bg in style.css: the mobile browser bar takes this colour.
const BACKGROUND = { light: "#fbfaf8", dark: "#151413" } as const;
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let system: MediaQueryList | undefined;

function read(): ThemePreference {
	try {
		const value = localStorage.getItem(KEY);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}

function apply(): void {
	const resolved = preference === "system" ? (system?.matches ? "dark" : "light") : preference;
	document.documentElement.dataset.theme = resolved;
	// The page has one theme-color per system scheme; an explicit choice overrides both.
	for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
		meta.setAttribute("content", BACKGROUND[resolved]);
}

function changed(): void {
	apply();
	for (const listener of listeners) listener();
}

/** Called once from main.tsx, before the first render. */
export function startTheme(): void {
	if (system) return;
	system = window.matchMedia("(prefers-color-scheme: dark)");
	preference = read();
	apply();
	system.addEventListener("change", apply);
	// Another tab of this origin changed the theme.
	window.addEventListener("storage", (event) => {
		if (event.key !== KEY && event.key !== null) return;
		preference = read();
		changed();
	});
}

export const getTheme = (): ThemePreference => preference;

export function subscribeTheme(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setTheme(next: ThemePreference): void {
	preference = next;
	try {
		if (next === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, next);
	} catch {}
	changed();
}
