// The client surfaces' portable part (slice 11): the scripts objects a server serves and clients hold, plugin scripts
// that register themselves, a client host kept connected and current, a host's loaded plugins, themes, and messages and
// languages.

// Messages as data live in the kernel since slice 15 (a denial carries one); re-exported here, where they were.
export { type MessageData, type MessageParam, MessageSchema } from "../data/message.ts";
export { followActiveLanguage, hostLanguage, type LanguageFollower } from "./active-language.ts";
export { followActiveTheme, type ThemeFollower } from "./active-theme.ts";
export {
	type Client,
	type ClientError,
	type ClientOptions,
	type ClientStyles,
	startClient,
} from "./client.ts";
export {
	type ConnectionState,
	keepConnected,
	type LoopEnvironment,
	type LoopLink,
	type LoopOptions,
	type SocketEvents,
} from "./connection.ts";
export { formatNumber, formatTime } from "./format.ts";
export { createLanguage, type Language, type MessagesReport } from "./language.ts";
export { LoadedFacets, type Prepared, type SetEntry } from "./loaded.ts";
export { LocaleChoice, localeChoiceFacet } from "./locale-choice.ts";
export {
	type Catalog,
	type CatalogShape,
	type DataKeys,
	defineMessages,
	type MessageArgs,
	type Messages,
	type MessagesOf,
	type MessageValue,
	type Translator,
} from "./messages.ts";
export {
	type ClientModules,
	evaluateRegistered,
	type FacetFunction,
	REGISTER,
	type RegisteredScript,
	registeredSource,
} from "./registered.ts";
export { type ScriptEntry, ScriptSet, type ScriptsContract, TuiScripts, WebScripts } from "./scripts.ts";
export { ThemeChoice, themeChoiceFacet } from "./theme-choice.ts";
export {
	activeTheme,
	BASE_ROLES,
	type BaseRole,
	type ColorDepth,
	FALLBACK_THEMES,
	type Theme,
	type ThemePick,
	Themes,
	terminalColor,
	themesFacet,
	themeVariables,
} from "./themes.ts";
export {
	type Translation,
	type TranslationIndex,
	Translations,
	translationsFacet,
} from "./translations.ts";
