import { VERSION } from "../../config.js";

export type ExtensionHostMode = "tui" | "rpc" | "json" | "print";

export type ExtensionHostCapability =
	| "prompt.system.chain.v1"
	| "session.lifecycle.reason.v1"
	| "ui.mode.v1"
	| "ui.confirm.timeout.v1"
	| "session.shutdown.v1";

export interface ExtensionHostCapabilities {
	readonly host_package: "@earendil-works/pi-coding-agent";
	readonly host_version: string;
	readonly extension_api_version: "1.0.0";
	readonly capabilities: readonly ExtensionHostCapability[];
}

const capabilities = Object.freeze<ExtensionHostCapability[]>([
	"prompt.system.chain.v1",
	"session.lifecycle.reason.v1",
	"ui.mode.v1",
	"ui.confirm.timeout.v1",
	"session.shutdown.v1",
]);

/**
 * Immutable host-owned extension protocol identity.
 *
 * Package/version are provenance. Consumers gate compatibility on the separately
 * versioned extension API plus exact capability tokens, not on repository or
 * environment supplied values.
 */
export const EXTENSION_HOST_CAPABILITIES: ExtensionHostCapabilities = Object.freeze({
	host_package: "@earendil-works/pi-coding-agent",
	host_version: VERSION,
	extension_api_version: "1.0.0",
	capabilities,
});
