// Hosts for Chord's layers: what the remote sides of links use of a host, its objects and references; what jobs use of
// a handler's ctx, the backoff and ids.

export { nextDelay } from "./backoff.ts";
export { CallContext, type Caller } from "./ctx.ts";
export type { AnyHost, ChordHost, Serving } from "./host.ts";
export type { PinnedKey } from "./keyed-members.ts";
export type { ChordObject, Holder } from "./object.ts";
export { LIVE, LOADING, type RefState } from "./ref-state.ts";
export { type Binding, type CheckedParams, type RetryOperation, retryOperation, type Target } from "./reference.ts";
export type { UnboundRequest } from "./unbound.ts";
export { uuidv7 } from "./uuid.ts";
