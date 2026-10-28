// Contracts for apps: declaring, evolving and implementing Chord object types.

export type { AcceptsTable } from "./accepts.ts";
export type { Contract, Implementation, KeyedWatchable, ParamsOf } from "./contract.ts";
export { local, remote } from "./declare.ts";
export { evolve } from "./evolve.ts";
export { type Address, type HostKind, hostKind, type KindShape, type ParamsOfKind } from "./host-kind.ts";
export {
	arr,
	type Bounds,
	bool,
	bytes,
	type Defaulted,
	int,
	type KeyedMember,
	keyed,
	lit,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	type TSchema,
	union,
	unknown,
} from "./schema.ts";
