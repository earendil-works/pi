// Data for apps: Chord's errors (with `invalid` and `forbidden`, the two a plugin throws), plugin errors, principals,
// and how a plugin's open reports a broken configuration.

export {
	ChordError,
	type ChordErrorCode,
	type ChordErrorReason,
	forbidden,
	invalid,
	isChordError,
	PluginError,
} from "./errors.ts";
export { broken, type FailureCause } from "./failure.ts";
export type { Principal, PrincipalKeyFunction } from "./principal.ts";
