/**
 * Public type contract for the "pi-plus" npm package's programmatic entry
 * (api.js). Hand-authored mirror of src/api.ts: the runtime is fully
 * self-contained in api.js (built from this repo with the pi-plus override
 * layer baked in), so this file only needs to re-export the upstream SDK
 * types and declare the pi-plus additions. A vitest drift guard
 * (test/api.test.ts) asserts every runtime export of src/api.ts appears here.
 */

export * from "@earendil-works/pi-coding-agent";

import type {
	AgentSession,
	AgentSessionRuntime,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	DefaultResourceLoaderOptions,
	ExtensionCommandContextActions,
	ExtensionError,
	ExtensionUIContext,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";

export declare const plusSdkExtensionFactories: InlineExtension[];

export interface PlusUIDialogHandlers {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor?(title: string, prefill?: string): Promise<string | undefined>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export declare function createPlusUIContext(handlers: PlusUIDialogHandlers): ExtensionUIContext;

export interface CreatePlusAgentSessionOptions extends CreateAgentSessionOptions {
	extensionFactories?: InlineExtension[];
	ui?: PlusUIDialogHandlers;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
}

export declare function createPlusAgentSession(
	options?: CreatePlusAgentSessionOptions,
): Promise<CreateAgentSessionResult>;

export interface CreatePlusAgentSessionRuntimeOptions extends CreateAgentSessionOptions {
	extensionFactories?: InlineExtension[];
	ui?: PlusUIDialogHandlers;
	/** Overrides the runtime-routed actions (switchSession/fork/newSession/...)
	 *  the factory wires by default, same shape as bindExtensions' binding. */
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
	/** Called after every extension bind: the initial session and each session
	 *  replacement. Re-subscribe to the new session here; the previous
	 *  AgentSession object is disposed after a replacement. */
	onRebind?: (session: AgentSession) => void | Promise<void>;
	/** Project-trust flag for per-cwd SettingsManagers (default true). */
	projectTrusted?: boolean;
	/** Loader passthroughs (additionalSkillPaths, noSkills, systemPrompt, ...)
	 *  applied on every recreation; cwd/agentDir/settingsManager/extensionFactories are owned by the factory. */
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager" | "extensionFactories"
	>;
}

/** Runtime-backed createPlusAgentSession: same pi-plus layer and binding rules,
 *  but returns an AgentSessionRuntime with CLI-level session replacement
 *  (/cd, newSession, fork/clone, switchSession). The live session is
 *  `runtime.session` — it changes on every replacement; hosts must NOT call
 *  bindExtensions themselves. */
export declare function createPlusAgentSessionRuntime(
	options?: CreatePlusAgentSessionRuntimeOptions,
): Promise<AgentSessionRuntime>;

/**
 * Profile management: the curated @earendil-works/pi-hub surface bundled into
 * api.js (profiles.json CRUD + per-profile materialized agent dirs). Types are
 * declared inline because pi-hub is not a dependency of this package — keep
 * them in sync with packages/hub/src/types.ts.
 */
export interface Profile {
	provider?: string;
	model?: string;
	models?: string[];
	thinking?: string;
	token?: string;
	url?: string;
	/** Arbitrary settings.json overrides, merged over the source agent settings.
	 *  A null value deletes the key from the materialized settings.json. */
	settings?: Record<string, unknown>;
}

export interface ProfilesData {
	profiles: Record<string, Profile>;
	default?: string;
}

export interface AgentSettingsData {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	skills?: unknown;
	[key: string]: unknown;
}

export declare const THINKING_LEVELS: string[];

/** Source agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent): profiles without an applied profile. */
export declare const AGENT_DIR: string;

export declare function loadProfiles(): ProfilesData;
export declare function findProfile(name: string): Profile | undefined;
export declare function getDefaultProfileName(): string | undefined;
export declare function setDefaultProfile(name: string): void;
export declare function clearDefaultProfile(): void;
/** Select a profile's default model (list position 1, materialized as
 *  settings.defaultModel); adds it when absent. Throws for an unknown profile,
 *  an empty model, or a new model beyond the 3-per-profile bound. */
export declare function setProfileDefaultModel(name: string, model: string): string;
export declare function addProfile(name: string, profile: Profile): void;
/** Append a model to a profile without selecting it; becomes the default when
 *  the profile had no model. Throws for an unknown profile, a duplicate or
 *  empty model, or a fourth model. */
export declare function addProfileModel(name: string, model: string): string;
export declare function updateProfile(name: string, profile: Profile): void;
export declare function removeProfile(name: string): void;
/** Remove a model from a profile; the default promotes to the next remaining
 *  model, and removing the last clears both `models` and `model`. A model not
 *  in the list is a no-op with a message; throws for an unknown profile. */
export declare function removeProfileModel(name: string, model: string): string;
export declare function renameProfile(oldName: string, newName: string): void;
export declare function profileDirFor(name: string): string;
export declare function materializeProfile(name: string, profile: Profile): string;
export declare function removeProfileDir(name: string): void;
export declare function syncProfilePackagesToSource(profileDir: string): boolean;

/**
 * Provider login: pi-plus's programmatic provider login bundled into api.js
 * (packages/plus/src/auth/login.ts) — pi's interactive /login equivalent,
 * which pi-plus disables in the TUI. The credential is persisted to
 * <agentDir>/auth.json, the same store pi reads at launch. The auth
 * vocabulary is declared inline because pi-ai is not a dependency of this
 * package — keep it in sync with packages/ai/src/auth/types.ts.
 */
export type AuthType = "api_key" | "oauth";

export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: Record<string, string>;
}

export interface OAuthCredential {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

export interface LoginProviderOptions {
	/** Agent dir whose auth.json stores the credential. Defaults to the active agent dir. */
	agentDir?: string;
	/** Flow UI callbacks. Defaults to a terminal interaction (stdin prompts + browser). */
	interaction?: AuthInteraction;
	/** Cancels the flow. */
	signal?: AbortSignal;
	/** Force a login method; defaults to oauth when the provider offers it, then api_key. */
	method?: AuthType;
}

export declare function loginProvider(providerId: string, options?: LoginProviderOptions): Promise<Credential>;

/** Readline-based AuthInteraction for terminal use (prompts on stdin, auth URLs opened in the browser). */
export declare function createTerminalAuthInteraction(): AuthInteraction;

// ---------------------------------------------------------------------------
// pi-plus settings store (~/.pi/agent/pi-plus-settings.json): auto-compaction
// threshold percent, context floor buffer and context window cap. Re-exported
// from packages/plus/src/context/threshold-setting.ts; the runtime bundle
// inlines the module. Pass an explicit `path` to read/write a specific agent
// dir's copy; the default follows the process agent dir (PI_AGENT_DIR).
// ---------------------------------------------------------------------------

/** Env var that overrides the settings file path (tests, debugging). */
export declare const PLUS_SETTINGS_ENV: "PI_PLUS_SETTINGS_FILE";

export interface PlusSettings {
	/** Percent (1-100) of the effective context window at which auto-compaction triggers. */
	autoCompactThresholdPercent?: number;
	/** Minimum floor buffer (tokens) for the effective context window (>= 13000). */
	contextFloorTokens?: number;
	/** Cap (tokens >= 32768) on the context window used for auto-compact math. */
	contextWindowCapTokens?: number;
}

export declare function getPlusSettingsPath(): string;
/** Read the store; missing or malformed files yield {} (never throws). */
export declare function readPlusSettings(path?: string): PlusSettings;
/** Persist the store, replacing only the fields present in `patch`; a field
 *  explicitly set to undefined deletes that key, absent fields are untouched. */
export declare function writePlusSettings(patch: PlusSettings, path?: string): void;

/** Default threshold: 80% of the effective context window. */
export declare const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT: number;
export declare function getAutoCompactThresholdPercent(): number;
/** Persist a choice; undefined resets to the default (deletes the key). */
export declare function setAutoCompactThresholdPercent(percent: number | undefined): void;
export declare function formatAutoCompactThresholdPercent(percent: number): string;
export declare function parseAutoCompactThresholdChoice(choice: string): number;

/** Default/built-in minimum context floor buffer. */
export declare const DEFAULT_CONTEXT_FLOOR_TOKENS: number;
export declare const MIN_CONTEXT_FLOOR_TOKENS: number;
export declare function getContextFloorTokens(): number;
export declare function setContextFloorTokens(tokens: number | undefined): void;
export declare function formatContextFloorTokens(tokens: number): string;
export declare function parseContextFloorChoice(choice: string): number;

/** Lowest accepted context window cap; undefined means no cap. */
export declare const MIN_CONTEXT_WINDOW_CAP_TOKENS: number;
export declare function getContextWindowCapTokens(): number | undefined;
export declare function setContextWindowCapTokens(tokens: number | undefined): void;
export declare function formatContextWindowCapTokens(tokens: number | undefined): string;
export declare function parseContextWindowCapChoice(choice: string): number | undefined;
