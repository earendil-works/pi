// Compiled checks: TypeBox validators of Chord-owned schemas, and the `invalid` error of a failed check.

import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { ResetExternal, ResetFunctions } from "typebox/schema";
import { Errors } from "typebox/value";
import type { Context } from "../../context/index.ts";
import type { TSchema } from "../contracts/schema.ts";
import { type ChordError, invalid } from "./errors.ts";

/** A Chord-owned record holding a schema: a snapshot, or a contract's params. */
type SchemaOwner = { readonly schema: TSchema };

/** The validator of an owner's schema, compiled on first use (counted) and cached weakly by the owner. */
export function validatorFor(owner: SchemaOwner, context: Context): Validator {
	let validator = validators.get(owner);
	if (validator === undefined) {
		context.telemetry.metrics?.counter("chord.data.compilations").add(1);
		try {
			validator = Compile(owner.schema);
		} finally {
			// TypeBox keeps its last build in module-level accumulators; reset them so no build state is retained.
			ResetFunctions();
			ResetExternal();
		}
		validators.set(owner, validator);
	}
	return validator;
}

const validators = new WeakMap<SchemaOwner, Validator>();

/** Checks `value` (counted); a failure throws `invalid/<reason>` with the first error's JSON Pointer path. */
export function check(
	validator: Validator,
	value: unknown,
	reason: "args" | "params" | "placement",
	context: Context,
): void {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validator.Check(value)) throw failedCheck(validator.Type(), value, reason, context);
}

/**
 * The error of a failed check: TypeBox's first error from its diagnostic walk (counted; it builds the whole list).
 * TypeBox does not escape `~` and `/` in its instance paths, so keys containing them make the path ambiguous.
 */
function failedCheck(
	schema: TSchema,
	value: unknown,
	reason: "args" | "params" | "placement",
	context: Context,
): ChordError {
	context.telemetry.metrics?.counter("chord.data.walks").add(1);
	const [error] = Errors(schema, value);
	const { path, problem } = describe(error);
	return invalid(reason, `${reason}${path === "/" ? "" : path}: ${problem}`, { path });
}

/**
 * The path and problem of a TypeBox error: TypeBox reports a missing field at its parent, and an unknown one as a
 * false schema (`additionalProperties: false`) at its own path. Anything else keeps TypeBox's message.
 */
function describe(error: TLocalizedValidationError): { path: string; problem: string } {
	if (error.keyword === "required") {
		return { path: `${error.instancePath}/${error.params.requiredProperties[0]}`, problem: "missing" };
	}
	if (error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")) {
		return { path: error.instancePath, problem: "unknown field" };
	}
	return { path: error.instancePath || "/", problem: error.message };
}
