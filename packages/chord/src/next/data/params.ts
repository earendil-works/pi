// Params and identity: the checked params of a get, their key, and the in-process identity of an object.

import type { Context } from "../../context/index.ts";
import { type Contract, contractData, type ParamsOf, type ShapeOf } from "../contracts/contract.ts";
import { type Address, addressKey } from "../contracts/host-kind.ts";
import { joinKey, type ParamsData } from "../contracts/params.ts";
import { check, validatorFor } from "./validator.ts";

/**
 * Checks `raw` against the contract's params with one compiled closed-object check (`invalid/params` on failure) and
 * returns the caller's own object with its key: the field values in declared order, each escaped, joined with `|`.
 */
export function checkParams<C extends Contract>(
	contract: C,
	raw: unknown,
	context: Context,
): { readonly params: ParamsOf<C>; readonly key: string } {
	const { params } = contractData(contract);
	check(validatorFor(params, context), raw, "params", context);
	// The check above establishes the params type.
	const checked = raw as ParamsOf<C> & { readonly [field: string]: string | number | boolean };
	return { params: checked, key: joinKey(params.fields.map((field) => String(checked[field]))) };
}

/** The in-process identity of an object: `name|key|principalKey`, each part escaped; `local` has no principal. */
export function identityKey<C extends Contract>(
	contract: C,
	key: string,
	...principalKey: ShapeOf<C>["kind"] extends "local" ? [] : [principalKey: string]
): string {
	return joinKey([contract.name, key, ...principalKey]);
}

/**
 * An address from a kind's name and params as a hold names it or a placement returned it: the params checked against
 * the kind's with one compiled closed-object check (`invalid/placement` on failure), the key computed.
 */
export function checkAddress(kind: string, params: ParamsData, raw: unknown, context: Context): Address {
	check(validatorFor(params, context), raw, "placement", context);
	// The check above establishes a flat record of the kind's scalar fields.
	const values = raw as { readonly [field: string]: string | number | boolean };
	return { kind, params: values, key: addressKey(kind, params, values) };
}
