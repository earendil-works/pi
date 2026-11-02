import type { Usage } from "@earendil-works/pi-ai";
import { obj, type Static, str } from "@earendil-works/pi-schema";
import type { AgentTool, AgentToolResult } from "../../src/types.ts";

export interface CalculateResult extends AgentToolResult<undefined> {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
}

export function calculate(expression: string): CalculateResult {
	try {
		const result = new Function(`return ${expression}`)();
		return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
	} catch (e: any) {
		throw new Error(e.message || String(e));
	}
}

const calculateSchema = obj(
	{ expression: str({ description: "The mathematical expression to evaluate" }) },
	// Open, as the tool accepted extra arguments before it moved from TypeBox.
	{ open: true },
);

type CalculateParams = Static<typeof calculateSchema>;

export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	label: "Calculator",
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
	execute: async (_toolCallId: string, args: CalculateParams) => {
		return calculate(args.expression);
	},
};

export function createCalculateToolWithUsage(usage: Usage): AgentTool<typeof calculateSchema, undefined> {
	return {
		...calculateTool,
		execute: async (_toolCallId: string, args: CalculateParams) => ({ ...calculate(args.expression), usage }),
	};
}
