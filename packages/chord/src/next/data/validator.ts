// Compiled checks: pi-schema validators of Chord-owned schemas, and the `invalid` error of a failed check.

import { compile, type JsonSchema, type Validator } from "@earendil-works/pi-schema";
import type { Context } from "../../context/index.ts";
import { type ChordError, invalid } from "./errors.ts";

/** A Chord-owned record holding a schema: a snapshot, or a contract's params. */
type SchemaOwner = { readonly schema: JsonSchema };

/** The validator of an owner's schema, compiled on first use (counted) and cached weakly by the owner. */
export function validatorFor(owner: SchemaOwner, context: Context): Validator {
	let validator = validators.get(owner);
	if (validator === undefined) {
		context.telemetry.metrics?.counter("chord.data.compilations").add(1);
		// `format` is an annotation (decided for the schema switch): no format checks are compiled in.
		validator = compile(owner.schema);
		validators.set(owner, validator);
	}
	return validator;
}

const validators = new WeakMap<SchemaOwner, Validator>();

/** Checks `value` (counted); a failure throws `invalid/<reason>` with the first error's JSON Pointer path. */
export function check(
	validator: Validator,
	value: unknown,
	reason: "args" | "params" | "host_address",
	context: Context,
): void {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validator.check(value)) throw failedCheck(validator, value, reason, context);
}

/**
 * The error of a failed check: the first error of the validator's explanation (counted: it walks the schema). A
 * missing field is reported at the field ("missing"), an unknown one at its own path ("unknown field"); the value
 * itself at `/`.
 */
function failedCheck(
	validator: Validator,
	value: unknown,
	reason: "args" | "params" | "host_address",
	context: Context,
): ChordError {
	context.telemetry.metrics?.counter("chord.data.walks").add(1);
	// A value that failed the check has at least one error.
	const error = validator.errors(value)[0]!;
	const path = error.path || "/";
	return invalid(reason, `${reason}${path === "/" ? "" : path}: ${error.message}`, { path });
}
