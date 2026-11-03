// Data for apps: Chord's errors and plugin errors, principals, and how a plugin's open reports a broken configuration.

export {
	ChordError,
	type ChordErrorCode,
	type ChordErrorReason,
	isChordError,
	PluginError,
} from "./errors.ts";
export { broken, type FailureCause } from "./failure.ts";
export type { Principal, PrincipalKeyFunction } from "./principal.ts";
