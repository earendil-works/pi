/**
 * Programmatic library entry for pi-plus-sdk ("pi-plus-sdk" npm package, `api.js`).
 *
 * Lets a host application (e.g. a desktop app) embed pi with the pi-plus layer
 * in-process, without going through the `pipi` CLI:
 * - the compaction/context/reasoning overrides are baked in at bundle time by
 *   the same redirect plugin that produces the CLI, because this module imports
 *   upstream runtime values ONLY through the coding-agent index barrel (direct
 *   relative imports of redirected upstream modules would bypass the wrappers)
 * - the nine non-TUI pi-plus extensions (subagent, tasks, memory, plan,
 *   ask-user, hooks, context-guard, /cd, /init) are registered here the same
 *   way the
 *   CLI wrapper registers them; the CLI-only ones (banner, vim, tab-title,
 *   plain-tools) live in the pi-plus artifact and are excluded from this
 *   bundle by construction
 * - hosts that want working ask_user dialogs provide dialog handlers via the
 *   `ui` option; the session is bound with mode "rpc" so ask-user falls back
 *   to sequential select/input/confirm dialogs, and with mode "print"
 *   otherwise (matching upstream's non-interactive modes)
 * - profile management (pi-hub profiles.json CRUD + agent-dir
 *   materialization) is re-exported from ./profiles.ts so hosts do not
 *   reimplement the pi-hub file contract
 * - provider login (OAuth login page / API-key setup, pi's /login equivalent,
 *   which pi-plus disables in the TUI) is re-exported from ./auth.ts
 *
 * Hosts without a pi CLI on PATH should pass excludeTools: ["subagent"]:
 * the subagent tool launches a pi subprocess and, in a CLI-less host such as
 * an Electron app, its invocation candidates can relaunch the host itself.
 */

export * from "../../coding-agent/src/index.ts";
export * from "./auth.ts";
export * from "./profiles.ts";

import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionCommandContextActions,
	ExtensionError,
	ExtensionUIContext,
	InlineExtension,
} from "../../coding-agent/src/index.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	initTheme,
	SettingsManager,
} from "../../coding-agent/src/index.ts";
import { theme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import {
	registerAskUser,
	registerCd,
	registerContextGuard,
	registerInit,
	registerMemory,
	registerPlan,
	registerSubagent,
	registerTasks,
	registerUserHooks,
} from "../../plus/src/extensions/index.ts";

/**
 * Hidden pi-plus extension factories for non-TUI (SDK) hosts: the same
 * registrations the `pipi` CLI wrapper makes, minus the TUI-only ones.
 * Passed to DefaultResourceLoader alongside any host-provided factories.
 */
export const plusSdkExtensionFactories: InlineExtension[] = [
	{ name: "pi-plus-subagent", factory: registerSubagent, hidden: true },
	{ name: "pi-plus-tasks", factory: registerTasks, hidden: true },
	{ name: "pi-plus-memory", factory: registerMemory, hidden: true },
	{ name: "pi-plus-plan", factory: registerPlan, hidden: true },
	{ name: "pi-plus-ask-user", factory: registerAskUser, hidden: true },
	{ name: "pi-plus-hooks", factory: registerUserHooks, hidden: true },
	{ name: "pi-plus-context-guard", factory: registerContextGuard, hidden: true },
	{ name: "pi-plus-cd", factory: registerCd, hidden: true },
	{ name: "pi-plus-init", factory: registerInit, hidden: true },
];

/**
 * Dialog callbacks a host implements to give extensions a minimal UI. select /
 * confirm / input are enough for the ask_user tool's non-TUI fallback; editor
 * and notify are optional conveniences (notify defaults to a no-op).
 */
export interface PlusUIDialogHandlers {
	/** Show a selector and return the chosen option label, or undefined when cancelled. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Show a confirmation dialog; false when declined or cancelled. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Show a text input dialog, or undefined when cancelled. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** Show a multi-line editor, or undefined when cancelled. */
	editor?(title: string, prefill?: string): Promise<string | undefined>;
	/** Show a notification (defaults to ignored). */
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

let themeInitialized = false;

/**
 * Build an ExtensionUIContext that bridges the supported dialogs to host
 * handlers and no-ops everything that needs a real terminal. The member set
 * mirrors the upstream no-op context (runner.ts noOpUIContext); initTheme()
 * is required because the exported `theme` proxy throws before it runs.
 */
export function createPlusUIContext(handlers: PlusUIDialogHandlers): ExtensionUIContext {
	if (!themeInitialized) {
		initTheme();
		themeInitialized = true;
	}
	return {
		select: (title, options) => handlers.select(title, options),
		confirm: (title, message) => handlers.confirm(title, message),
		input: (title, placeholder) => handlers.input(title, placeholder),
		editor: async (title, prefill) => (handlers.editor ? handlers.editor(title, prefill) : undefined),
		notify: (message, type) => handlers.notify?.(message, type),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not supported in SDK hosts" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export interface CreatePlusAgentSessionOptions extends CreateAgentSessionOptions {
	/** Additional host extension factories, appended after the pi-plus ones. */
	extensionFactories?: InlineExtension[];
	/**
	 * Dialog handlers for extension UI. When provided, the session is bound
	 * with mode "rpc" and ask_user works through sequential dialogs; when
	 * omitted, the session is bound with mode "print" (no dialogs).
	 */
	ui?: PlusUIDialogHandlers;
	/** One-shot ExtensionBindings passthroughs (see AgentSession.bindExtensions). */
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
}

/**
 * Create an AgentSession with the pi-plus layer and extensions, for hosts
 * that embed pi in-process instead of running the `pipi` CLI.
 *
 * Differences from the upstream createAgentSession:
 * - the nine non-TUI pi-plus extensions are registered on the resource loader
 * - the loader is reloaded here (createAgentSession skips reload for a
 *   caller-supplied loader), with one SettingsManager shared by both
 * - extensions are always bound once afterwards, which is what emits the
 *   session start event plus extensions subscribe to (memory recall, hooks);
 *   a host must NOT call bindExtensions again — that would re-emit it
 */
export async function createPlusAgentSession(
	options: CreatePlusAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const { extensionFactories, ui, ...rest } = options;
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [...plusSdkExtensionFactories, ...(extensionFactories ?? [])],
	});
	await resourceLoader.reload();
	const result = await createAgentSession({
		...rest,
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
	});
	await result.session.bindExtensions({
		uiContext: ui ? createPlusUIContext(ui) : undefined,
		mode: ui ? "rpc" : "print",
		commandContextActions: options.commandContextActions,
		abortHandler: options.abortHandler,
		shutdownHandler: options.shutdownHandler,
		onError: options.onError,
	});
	return result;
}
