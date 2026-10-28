// Contracts for Chord's layers: accepted versions, the data behind a contract handle, and the types L4 dispatches on.

export { checkAccepts } from "./accepts.ts";
export {
	type ContractShape,
	type CurrentVariants,
	contractData,
	currentVariants,
	LOCAL,
	type MethodData,
	type ShapeOf,
	takesNoArgs,
	type VariantData,
	type VariantImplementation,
	type VariantNames,
	variantNames,
	variantOrder,
} from "./contract.ts";
export { editWith } from "./evolve.ts";
export { fingerprintOf, hash64, NORMAL_FORM_VERSION } from "./fingerprint.ts";
export type { Increment } from "./history.ts";
export { kindParams } from "./host-kind.ts";
export { checkName } from "./names.ts";
export type { Params, ParamsData } from "./params.ts";
export { Method } from "./schema.ts";
