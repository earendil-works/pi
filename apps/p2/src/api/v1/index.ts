// p2's plugin API, version 1 (`@p2/app/v1`): what every facet kind may import (browser-safe). Plugins import p2 and
// Chord v2 only through this API and its per-kind modules (`/node`, `/server`, `/worker`, `/tui`, `/web`), never through
// relative paths into `src`: a plugin is built and reloaded on its own, and the API is the code its host provides.

export {
	type AcceptsTable,
	type Address,
	broken,
	ChordError,
	type Contract,
	constant,
	defineRegistry,
	defineState,
	evolve,
	type HandleOf,
	isChordError,
	type KeyedHandle,
	keyed,
	keyedEntries,
	local,
	mapShared,
	method,
	type Native,
	orderedEntries,
	PluginError,
	type RefState,
	type Registry,
	type RegistryValue,
	remote,
	type SingletonHandle,
	sleep,
	type Tx,
	untilAborted,
	type Watchable,
	type Writable,
} from "@earendil-works/chord";
export {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	withAbortSignal,
	withCancel,
} from "@earendil-works/chord/context";
export type { JsonValue } from "@earendil-works/chord/json";
export type { NativeWatchable, WatchCall, WatchHandle } from "@earendil-works/chord/watch";
export * from "../../runtime/access.ts";
export * from "../../runtime/chord.ts";
export * from "../../runtime/composer.ts";
export * from "../../runtime/contribute.ts";
export * from "../../runtime/dev-protocol.ts";
export * from "../../runtime/entries.ts";
export * from "../../runtime/file-index.ts";
export * from "../../runtime/files.ts";
export * from "../../runtime/input.ts";
export * from "../../runtime/location.ts";
export * from "../../runtime/notices.ts";
export * from "../../runtime/principals.ts";
export * from "../../runtime/refs.ts";
export * from "../../runtime/schema.ts";
export * from "../../runtime/schemas.ts";
export * from "../../runtime/session-worker.ts";
export * from "../../runtime/shell.ts";
export * from "../../runtime/speaker.ts";
