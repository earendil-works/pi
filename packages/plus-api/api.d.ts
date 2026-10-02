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

/** Marker stored in `profiles.json` `default` meaning "no profile, run plain pi". */
export declare const BUILT_IN_DEFAULT: "__builtin__";

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
