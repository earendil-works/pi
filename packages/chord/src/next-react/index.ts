// Chord v2's React bindings (`@earendil-works/chord/next/react` once v2 has its entry point; slice 11 §3): optional,
// non-React apps never load them.

export { HostProvider, useHold, useHost, useRefState, useRegistry, useWatch } from "./hooks.ts";
export { type ExternalStore, watchStore } from "./stores.ts";
