// compile(): a schema to a Validator, whose `check` is the fast boolean path and whose `errors` explains failures.

import type { Static } from "./builders.ts";
import { Coercer } from "./coerce.ts";
import { Compiler, RESTART } from "./compiler.ts";
import { Explainer } from "./explain.ts";
import type { Check, CompileOptions, JsonSchema, ParseResult, ValidationError } from "./types.ts";

/**
 * Compiles `schema` into a Validator. Throws if the schema is malformed or a `$ref` names nothing (register other
 * documents with `options.schemas`). The schema is read, never modified. With `coerce: true` the validator also
 * coerces and parses loosely typed input.
 */
export function compile<S extends JsonSchema>(
	schema: S,
	options: CompileOptions & { readonly coerce: true },
): CoercingValidator<Static<S>>;
export function compile<S extends JsonSchema>(schema: S, options?: CompileOptions): Validator<Static<S>>;
export function compile<S extends JsonSchema>(
	schema: S,
	options: CompileOptions = NO_OPTIONS,
): Validator<Static<S>> | CoercingValidator<Static<S>> {
	const check = compileCheck(schema, options);
	return options.coerce === true
		? new CoercingValidator(schema, options, check)
		: new Validator(schema, options, check);
}

const NO_OPTIONS: CompileOptions = Object.freeze({});

/** A compiled schema whose valid values have type `T` (`unknown` unless the schema was built with the builders). */
export class Validator<T = unknown> {
	/** Whether `value` is valid. A plain function: it may be passed around without its validator. */
	readonly check: (value: unknown) => value is T;
	protected readonly schema: JsonSchema;
	protected readonly options: CompileOptions;
	private explainer: Explainer | undefined = undefined;

	constructor(schema: JsonSchema, options: CompileOptions, check: Check) {
		// A compiled check is exactly the test that a value has the schema's static type.
		this.check = check as (value: unknown) => value is T;
		this.schema = schema;
		this.options = options;
	}

	/**
	 * Why `value` is invalid: one error per failing keyword, `[]` when it is valid. Built on the first failure and
	 * kept, so a validator whose values always pass never pays for it.
	 */
	errors(value: unknown): ValidationError[] {
		if (this.check(value)) return [];
		this.explainer ??= new Explainer(compiler(this.schema, this.options), this.schema);
		return this.explainer.errors(value);
	}
}

/** A validator compiled with `coerce: true`: it also coerces loosely typed input towards the schema. */
export class CoercingValidator<T = unknown> extends Validator<T> {
	private coercer: Coercer | undefined = undefined;

	/**
	 * `value` coerced towards the schema: numeric strings to numbers, `"true"` to `true`, a single value to a one-item
	 * array, an optional `null` dropped, the first union branch the value converts to (the README lists every rule).
	 * Only the changed paths are copied; `value` comes back itself when nothing changes, and is never modified. Values
	 * that cannot be coerced stay as they are. The rules are built on the first call.
	 */
	coerce(value: unknown): unknown {
		this.coercer ??= new Coercer(compiler(this.schema, this.options), this.schema);
		return this.coercer.coerce(value);
	}

	/** Coerces `value`, then checks it: the coerced value when it is valid, else its errors. */
	parse(value: unknown): ParseResult<T> {
		const coerced = this.coerce(value);
		return this.check(coerced) ? { ok: true, value: coerced } : { ok: false, errors: this.errors(coerced) };
	}
}

function compileCheck(schema: JsonSchema, options: CompileOptions): Check {
	return compiler(schema, options).root();
}

// Most schemas compile without tracking the dynamic scope; one with a bookended $dynamicRef compiles again with it.
function compiler(schema: JsonSchema, options: CompileOptions): Compiler {
	const plain = new Compiler(schema, options, false);
	try {
		plain.root();
		return plain;
	} catch (error) {
		if (error !== RESTART) throw error;
		return new Compiler(schema, options, true);
	}
}
