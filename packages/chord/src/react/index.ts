// Chord v2's React bindings (`@earendil-works/chord/react`; slice 11 §3): optional, non-React apps never load them.

export {
	HostProvider,
	useEvents,
	useHold,
	useHost,
	useMessages,
	usePageState,
	useRefState,
	useRegistry,
	useWatch,
} from "./hooks.ts";
export { type ExternalStore, watchStore } from "./stores.ts";
