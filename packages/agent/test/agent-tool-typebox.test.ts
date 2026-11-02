// AgentTool params typed from a TypeBox-built parameter schema. pi-agent-core does not depend on TypeBox: the schema
// below has TypeBox 1.x's type shapes as its d.mts declare them; pi-schema's own tests check the shapes against TypeBox.

import { describe, expectTypeOf, it } from "vitest";
import type { AgentTool } from "../src/types.ts";

interface TString {
	"~kind": "String";
	type: "string";
}

interface TLiteral<Value> {
	"~kind": "Literal";
	const: Value;
}

interface TUnion<Branches> {
	"~kind": "Union";
	anyOf: Branches;
}

interface TObject<Properties> {
	"~kind": "Object";
	type: "object";
	properties: Properties;
	required: string[];
}

type TOptional<Schema> = Schema & { "~optional": true };

const parameters: TObject<{ command: TString; mode: TOptional<TUnion<[TLiteral<"fast">, TLiteral<"deep">]>> }> = {
	"~kind": "Object",
	type: "object",
	properties: {
		command: { "~kind": "String", type: "string" },
		mode: {
			"~kind": "Union",
			anyOf: [
				{ "~kind": "Literal", const: "fast" },
				{ "~kind": "Literal", const: "deep" },
			],
			"~optional": true,
		},
	},
	required: ["command"],
};

type Params = { command: string; mode?: "fast" | "deep" };

describe("AgentTool params of a TypeBox schema", () => {
	it("are typed by the schema in execute() and prepareArguments()", () => {
		const tool: AgentTool<typeof parameters> = {
			name: "bash",
			label: "Bash",
			description: "Runs a command",
			parameters,
			async execute(_toolCallId, params) {
				expectTypeOf(params).toEqualTypeOf<Params>();
				return { content: [], details: undefined };
			},
		};
		expectTypeOf<Parameters<typeof tool.execute>[1]>().toEqualTypeOf<Params>();
		expectTypeOf<ReturnType<NonNullable<typeof tool.prepareArguments>>>().toEqualTypeOf<Params>();
	});
});
