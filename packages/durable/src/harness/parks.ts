// Tool parks: what `execute()` returns instead of a result to sleep or wait, its shape check, and how the Harness tells
// a base tool's parks from a wrapper's.
import type { ToolExecutionApi, ToolExecutionResult, ToolPark, ToolRegistration } from "./types.ts";

/** Whether `execute()` returned a park rather than a result. */
export function isPark(returned: ToolExecutionResult | ToolPark): returned is ToolPark {
	return "sleep" in returned || "wait" in returned;
}

/**
 * The parks a wrapped base returned in one run of a tool, carried by that run's api under this key. An own enumerable
 * symbol property, so a wrapper that spreads the api, as wrappers do, passes it on to the base.
 */
export const BASE_PARKS: unique symbol = Symbol("pi.tool.baseParks");

/** A run's api with the parks its wrapped base returned. */
export type ParkCarrier = { readonly [BASE_PARKS]?: Set<ToolPark> };

/** Fields of a result; a park carrying one of them is invalid. */
const RESULT_FIELDS = ["output", "structuredOutput", "isError", "details", "diagnostics", "usage", "control"] as const;

/**
 * Why a park breaks its shape (spec suspendable §4.1), or `undefined`: exactly one of `sleep` and `wait`, no result
 * field, and, when `tool` is a wrapper's composite (§9), one its base returned in this run, whose api is `api`. Rules
 * on what it waits for are the commit's.
 */
export function parkError(tool: ToolRegistration, park: ToolPark, api: ParkCarrier): string | undefined {
	// Tool code is a trust boundary for the mixed objects its types forbid.
	if ("sleep" in park && "wait" in park) return "a park has either sleep or wait, not both";
	const field = RESULT_FIELDS.find((name) => name in park);
	if (field !== undefined) return `a park has no result field, but this one has ${field}`;
	if (composites.has(tool) && api[BASE_PARKS]?.has(park) !== true) {
		return "a wrapper returned a park its base did not return";
	}
	return undefined;
}

/** Composite tools a wrapper built; their parks must come from their base. */
const composites = new WeakSet<ToolRegistration>();

/**
 * Apply `wrap` to `tool` as tool wrappers apply (spec suspendable §9): the first wrapper of a base gets a copy whose
 * `execute()` records every park it returns in its run's api, so the composite's own parks are told apart.
 */
export function wrapComposite<Tool extends ToolRegistration>(tool: Tool, wrap: (tool: Tool) => Tool): Tool {
	const base: Tool = composites.has(tool)
		? tool
		: {
				...tool,
				execute: async (args, api: ToolExecutionApi & ParkCarrier, context) => {
					const returned = await tool.execute(args, api, context);
					if (isPark(returned)) api[BASE_PARKS]?.add(returned);
					return returned;
				},
			};
	const composite = wrap(base);
	composites.add(composite);
	return composite;
}
