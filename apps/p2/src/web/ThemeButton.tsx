// The sidebar's theme control: cycles System → Light → Dark; the choice is kept per browser (theme.ts).
import { type ComponentType, useSyncExternalStore } from "react";
import { MoonIcon, SunIcon, SystemThemeIcon } from "./icons.tsx";
import { getTheme, setTheme, subscribeTheme, type ThemePreference } from "./theme.ts";

/** Each theme preference's label and icon, and the one the sidebar's button switches to next. */
export const THEME_CHOICES: Readonly<
	Record<ThemePreference, { readonly label: string; readonly icon: ComponentType; readonly next: ThemePreference }>
> = {
	system: { label: "System", icon: SystemThemeIcon, next: "light" },
	light: { label: "Light", icon: SunIcon, next: "dark" },
	dark: { label: "Dark", icon: MoonIcon, next: "system" },
};

/** Cycles System → Light → Dark; the choice is kept per browser. */
export function ThemeButton() {
	const theme = useThemePreference();
	const { label, icon: Icon, next } = THEME_CHOICES[theme];
	return (
		<button
			type="button"
			className="icon-button theme-toggle"
			onClick={() => setTheme(next)}
			aria-label={`Theme: ${label}. Switch to ${THEME_CHOICES[next].label}`}
			title={`Theme: ${label}`}
		>
			<Icon />
		</button>
	);
}

/** This browser's theme preference, re-rendering on change. */
export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}
