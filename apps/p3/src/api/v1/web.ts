// p3's API v1 for web facets (`@earendil-works/p3/v1/web`): Chord's React bindings, the page's one slot (`PageRoot`,
// the chrome plugin's), the connection state, the components plugins offer each other as typed tokens
// (`defineComponent`, `Components`, `useComponent`), the page's route (`useRoute`, `navigate`, `redirect`), and the
// icons p3 offers, and `refusalText` (a refusal as the person reads it). The built-in plugins' web contracts p3 promises are re-exported here (the layout plugin's pane
// layout among them). Browser only.

/// <reference path="./css.d.ts" />

import { type ConnectionState, defineRegistry, type TableItem } from "@earendil-works/chord";
import { useRegistry } from "@earendil-works/chord/react";
import { type ComponentType, useEffect, useSyncExternalStore } from "react";
import { BACKGROUND_CONTEXT, reportError } from "./index.ts";

export * from "@earendil-works/chord/react";
// The icons p3 offers web facets, by name: Elanor's whole set would weigh 695 KB gzipped in every page, so a plugin
// imports icons from here (one outside the set fails its type check) and a new one is an API addition.
export {
	AddIcon,
	AppsIcon,
	ArchiveIcon,
	ArrowBackIcon,
	BuildIcon,
	CancelIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CloseIcon,
	CodeIcon,
	ContentCopyIcon,
	DarkModeIcon,
	DeleteIcon,
	DescriptionIcon,
	EditIcon,
	ErrorIcon,
	ExpandLessIcon,
	ExpandMoreIcon,
	FolderIcon,
	GroupIcon,
	HistoryIcon,
	InfoIcon,
	KeyboardArrowDownIcon,
	KeyboardArrowUpIcon,
	LightModeIcon,
	LinkIcon,
	LogoutIcon,
	MenuIcon,
	MoreHorizIcon,
	MoreVertIcon,
	PersonAddIcon,
	PersonIcon,
	PersonRemoveIcon,
	RefreshIcon,
	SearchIcon,
	SendIcon,
	SettingsIcon,
	SmartToyIcon,
	StopIcon,
	TerminalIcon,
	UnarchiveIcon,
	WarningIcon,
} from "@earendil-works/elanor-icons-react";
// The shapes of a conversation as Durable and pi-ai give them, for views of a transcript (types only: nothing loads).
export type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
export type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
export * from "../../../plugins/apps/contract.web.ts";
export * from "../../../plugins/layout/contract.web.tsx";
export * from "../../../plugins/sessions/contract.web.tsx";
export * from "../../../plugins/transcript/contract.web.ts";
export { refusalText } from "./refusal.ts";

/**
 * The page's root: the one component the base renders inside the page's host (the chrome plugin's: the top bar and
 * the chosen app's page). The first by plugin name is used; a second is reported.
 */
export const PageRoot = defineRegistry<ComponentType, ComponentType | undefined>("p3.page-root", { version: 1 });

/** The page's connection to its server, as the base follows it: connecting, connected, or waiting to retry. */
export const PageConnection = defineRegistry<ConnectionState, ConnectionState>("p3.page-connection", { version: 1 });

/** A component a plugin offers others to place, named once, with the props it takes (`defineComponent`). */
export type ComponentToken<Props> = { readonly name: string; readonly "~props"?: (props: Props) => Props };

/** Defines a component (in its plugin's `contract.web.ts`): its name and, by type, its props. */
export function defineComponent<Props>(name: string): ComponentToken<Props> {
	return { name };
}

/** One component and its implementation, as `Components` takes it (`componentOf` makes one with the types checked). */
export type ComponentEntry = { readonly token: ComponentToken<never>; readonly component: ComponentType<never> };

/** `component` as the component `token`: the props are the token's. */
export function componentOf<Props>(token: ComponentToken<Props>, component: ComponentType<Props>): ComponentEntry {
	// A component's props are its token's by construction; the registry keeps them erased.
	return { token, component } as unknown as ComponentEntry;
}

/**
 * The components every plugin offers: a plugin contributes its list; a name taken twice keeps the first by plugin
 * name.
 */
export const Components = defineRegistry<readonly ComponentEntry[], ReadonlyMap<string, TableItem<ComponentEntry>>>(
	"p3.components",
	{ version: 1 },
);

/**
 * The implementation of `token`, or `undefined` while no plugin offers it, and for a token the running page does not
 * have (reported once per mount): a plugin built against a newer API than this page's base, whose token is undefined
 * here.
 */
export function useComponent<Props>(token: ComponentToken<Props>): ComponentType<Props> | undefined {
	const components = useRegistry(Components);
	// Trust boundary: version skew between a plugin and the page's base, which the types cannot see.
	const missing = (token as ComponentToken<Props> | undefined) === undefined;
	useEffect(() => {
		if (missing)
			reportError(
				"p3 web: a component this page's base does not have (restart the server)",
				undefined,
				BACKGROUND_CONTEXT,
			);
	}, [missing]);
	if (missing) return undefined;
	// The entry was registered for this token's name with its props (`componentOf`).
	return components?.get(token.name)?.value.component as ComponentType<Props> | undefined;
}

/** Where the page is: the app (the first segment of the path) and the rest of the path, split by `/`. */
export type Route = { readonly app: string | undefined; readonly rest: readonly string[] };

/** The page's route, following the browser's history. */
export function useRoute(): Route {
	const path = useSyncExternalStore(subscribe, () => location.pathname);
	return routeOf(path);
}

/** Goes to `path` (`/<app>/...`) without reloading the page. */
export function navigate(path: string): void {
	history.pushState(null, "", path);
	dispatchEvent(new Event(NAVIGATED));
}

/**
 * Goes to `path` in place of where the page is (a redirect: going back skips the path it left). For a path the page
 * leaves at once, such as `/` going to the first app: with `navigate` there, going back would land on `/`, which goes
 * forward again, and the person could never go back past it.
 */
export function redirect(path: string): void {
	history.replaceState(null, "", path);
	dispatchEvent(new Event(NAVIGATED));
}

/** The event `navigate` dispatches; `popstate` covers back and forward. */
const NAVIGATED = "p3:navigate";

/** Subscribes `changed` to the route's changes. */
function subscribe(changed: () => void): () => void {
	addEventListener("popstate", changed);
	addEventListener(NAVIGATED, changed);
	return () => {
		removeEventListener("popstate", changed);
		removeEventListener(NAVIGATED, changed);
	};
}

/** `path` as a route. */
function routeOf(path: string): Route {
	const [app, ...rest] = path
		.split("/")
		.filter((segment) => segment !== "")
		.map(decodeURIComponent);
	return { app, rest };
}
