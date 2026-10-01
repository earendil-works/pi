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
