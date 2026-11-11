// The app layout's part of the command menu: Show sidebar and Hide sidebar, Close side panel while one is open, and
// Change theme… with its page (the theme switch's choices, the current one checked).
import {
	type Command,
	CommandMenu,
	type CommandPage,
	closePanel,
	openSidebar,
	PanelSideIcon,
	SIDEBAR_DOCKS,
	SidebarIcon,
	SystemThemeIcon,
	setSidebarCollapsed,
	setTheme,
	THEME_CHOICES,
	type ThemePreference,
	useCommandMatches,
	useCommandMenu,
	useRoute,
	useSidebarCollapsed,
	useSidebarDocked,
	useThemePreference,
} from "@p2/app/v1/web";
import type { ReactNode } from "react";

/** The commands, by id. */
export const SHELL_COMMANDS: Readonly<Record<string, Command>> = {
	"web-shell.show-sidebar": {
		title: "Show sidebar",
		group: "Layout",
		order: 70,
		icon: SidebarIcon,
		keywords: ["open sidebar", "toggle sidebar", "sessions"],
		Shown: SidebarHidden,
		action: { kind: "run", run: openSidebar },
	},
	"web-shell.hide-sidebar": {
		title: "Hide sidebar",
		group: "Layout",
		order: 70,
		icon: SidebarIcon,
		keywords: ["collapse sidebar", "toggle sidebar"],
		Shown: SidebarDocked,
		action: { kind: "run", run: hideSidebar },
	},
	"web-shell.close-side-panel": {
		title: "Close side panel",
		group: "Layout",
		order: 70,
		icon: PanelSideIcon,
		keywords: ["hide panel", "activity"],
		Shown: SidePanelOpen,
		action: { kind: "run", run: closePanel },
	},
	"web-shell.theme": {
		title: "Change theme…",
		group: "Settings",
		order: 80,
		icon: SystemThemeIcon,
		keywords: ["dark mode", "light mode", "appearance", "color scheme"],
		action: { kind: "page", page: "theme" },
	},
};

/** The pages, by name. */
export const SHELL_PAGES: Readonly<Record<string, CommandPage>> = {
	theme: { label: "Theme", placeholder: "Search themes…", Body: ThemePage },
};

/** Collapses the docked sidebar; below the docking width the sessions are a drawer, which the menu's close closed. */
function hideSidebar(): void {
	if (window.matchMedia(SIDEBAR_DOCKS).matches) setSidebarCollapsed(true);
}

/** Renders `children` while the sidebar is not on screen: collapsed, or (not docked) the drawer. */
function SidebarHidden({ children }: { children: ReactNode }) {
	const docked = useSidebarDocked();
	const collapsed = useSidebarCollapsed();
	return !docked || collapsed ? children : null;
}

/** Renders `children` while the sidebar is docked and expanded. */
function SidebarDocked({ children }: { children: ReactNode }) {
	const docked = useSidebarDocked();
	const collapsed = useSidebarCollapsed();
	return docked && !collapsed ? children : null;
}

/** Renders `children` while the side panel shows something (the workspace panel takes its place while open). */
function SidePanelOpen({ children }: { children: ReactNode }) {
	const { activity, panel, workspace } = useRoute();
	return (activity || panel) && !workspace ? children : null;
}

/** The theme switch's choices, in its cycle's order. */
const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const themeText = (theme: ThemePreference): string => THEME_CHOICES[theme].label;

/** System, Light and Dark, this browser's choice checked; picking one applies it at once, as the theme switch does. */
function ThemePage() {
	const { close } = useCommandMenu();
	const current = useThemePreference();
	const matches = useCommandMatches(THEMES, themeText);
	return (
		<CommandMenu.Group heading="Theme">
			{matches.map((theme) => (
				<CommandMenu.Row
					key={theme}
					title={THEME_CHOICES[theme].label}
					icon={THEME_CHOICES[theme].icon}
					checked={theme === current}
					onSelect={async () => {
						await close();
						setTheme(theme);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}
