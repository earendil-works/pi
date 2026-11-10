// The sidebar's theme control: cycles System → Light → Dark; the choice is kept per browser (theme.ts).
import { type ReactNode, useSyncExternalStore } from "react";
import { MoonIcon, SunIcon, SystemThemeIcon } from "./icons.tsx";
import { getTheme, setTheme, subscribeTheme, type ThemePreference } from "./theme.ts";

const THEMES: Record<ThemePreference, { label: string; icon: ReactNode; next: ThemePreference }> = {
	system: { label: "System", icon: <SystemThemeIcon />, next: "light" },
	light: { label: "Light", icon: <SunIcon />, next: "dark" },
	dark: { label: "Dark", icon: <MoonIcon />, next: "system" },
};

/** Cycles System → Light → Dark; the choice is kept per browser. */
export function ThemeButton() {
	const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
	const { label, icon, next } = THEMES[theme];
	return (
		<button
			type="button"
			className="icon-button theme-toggle"
			onClick={() => setTheme(next)}
			aria-label={`Theme: ${label}. Switch to ${THEMES[next].label}`}
			title={`Theme: ${label}`}
		>
			{icon}
		</button>
	);
}
