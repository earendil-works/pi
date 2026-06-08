/**
 * Deprecated compatibility entry point for the former hooks API.
 *
 * Hooks were merged into the extension system, but the published package still
 * exposes `@earendil-works/pi-coding-agent/hooks`. Keep that subpath
 * importable and map the common hook names to their extension equivalents.
 */

export type {
	AppendEntryHandler,
	Extension as LoadedHook,
	ExtensionAPI as HookAPI,
	ExtensionCommandContext as HookCommandContext,
	ExtensionContext as HookContext,
	ExtensionError as HookError,
	ExtensionErrorListener as HookErrorListener,
	ExtensionEvent as HookEvent,
	ExtensionFactory as HookFactory,
	ExtensionFlag as HookFlag,
	ExtensionHandler as HookHandler,
	ExtensionShortcut as HookShortcut,
	ExtensionUIContext as HookUIContext,
	ForkHandler as BranchHandler,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	LoadExtensionsResult as LoadHooksResult,
	NavigateTreeHandler,
	NewSessionHandler,
	SendMessageHandler,
	SetActiveToolsHandler,
} from "../extensions/index.ts";
export * from "../extensions/index.ts";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions as discoverAndLoadHooks,
	loadExtensions as loadHooks,
} from "../extensions/loader.ts";
export { ExtensionRunner as HookRunner } from "../extensions/runner.ts";
export {
	wrapRegisteredTool as wrapToolWithHooks,
	wrapRegisteredTools as wrapToolsWithHooks,
} from "../extensions/wrapper.ts";
export type { ReadonlySessionManager } from "../session-manager.ts";
