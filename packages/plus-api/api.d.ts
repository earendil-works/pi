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
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
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
export declare function addProfile(name: string, profile: Profile): void;
export declare function updateProfile(name: string, profile: Profile): void;
export declare function removeProfile(name: string): void;
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
