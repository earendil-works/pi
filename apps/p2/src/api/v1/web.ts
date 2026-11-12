// p2's plugin API, version 1, for web facets (`@p2/app/v1/web`): the browser runtime (objects as React hooks, slots,
// sheets, navigation) and the shared components and stores of p2's page (chat, drawer, viewers, icons).
export * from "../../runtime/web.tsx";
export * from "../../web/AppLayout.tsx";
export * from "../../web/activity/api.ts";
export { reportClientError } from "../../web/app-boundary.tsx";
export * from "../../web/artifact-kinds.ts";
export * from "../../web/Chat.tsx";
export * from "../../web/Code.tsx";
export * from "../../web/CostPanel.tsx";
export { CommandMenu } from "../../web/command-menu/CommandMenu.tsx";
export {
	type CommandMenuActions,
	useCommandMenu,
	useCommandQuery,
	useCommandTarget,
} from "../../web/command-menu/context.ts";
export { useCommandMatches } from "../../web/command-menu/match.ts";
export {
	type CommandMenuRow,
	type CommandTargetRow,
	useCommandMenuRow,
	useCommandRouteTarget,
	useCommandTargetRow,
} from "../../web/command-menu/targets.ts";
export { conversationKey } from "../../web/composer-focus.ts";
export * from "../../web/composer-state.tsx";
export * from "../../web/conversation-cache.ts";
export * from "../../web/drag-size.ts";
export * from "../../web/ErrorToast.tsx";
export * from "../../web/file-completion.tsx";
export * from "../../web/haptics.ts";
export * from "../../web/history.ts";
export * from "../../web/icons.tsx";
export * from "../../web/Markdown.tsx";
export * from "../../web/ModelPicker.tsx";
export * from "../../web/navigation.ts";
export * from "../../web/navigation-components.ts";
export * from "../../web/new-session.tsx";
export * from "../../web/PiLogo.tsx";
export * from "../../web/path-label.ts";
export * from "../../web/query-cache.ts";
export * from "../../web/reconnect.ts";
export * from "../../web/SessionStats.tsx";
export * from "../../web/SettingsNav.tsx";
export * from "../../web/SidePanel.tsx";
export * from "../../web/Switch.tsx";
export * from "../../web/shared-context.ts";
export * from "../../web/sidebar.ts";
export * from "../../web/ThemeButton.tsx";
export { setTheme, type ThemePreference } from "../../web/theme.ts";
export * from "../../web/transcript.ts";
export * from "../../web/use-chat-scroll.ts";
export * from "../../web/Viewer.tsx";
export * from "../../web/view-kinds.ts";
export * from "../../web/virtual-list.ts";
