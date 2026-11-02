// Tool arguments typed from a TypeBox-built parameter schema. Durable does not depend on TypeBox: the schema below
// has TypeBox 1.x's type shapes as its d.mts declare them; pi-schema's own tests check the shapes against TypeBox.

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expectTypeOf, it } from "vitest";

interface TString {
	"~kind": "String";
	type: "string";
}

interface TInteger {
	"~kind": "Integer";
	type: "integer";
}

interface TArray<Items> {
	"~kind": "Array";
	type: "array";
	items: Items;
}

interface TObject<Properties> {
	"~kind": "Object";
	type: "object";
	properties: Properties;
	required: string[];
}

type TOptional<Schema> = Schema & { "~optional": true };

const parameters: TObject<{ path: TString; offset: TOptional<TInteger>; tags: TArray<TString> }> = {
	"~kind": "Object",
	type: "object",
	properties: {
		path: { "~kind": "String", type: "string" },
		offset: { "~kind": "Integer", type: "integer", "~optional": true },
		tags: { "~kind": "Array", type: "array", items: { "~kind": "String", type: "string" } },
	},
	required: ["path", "tags"],
};

type Args = { path: string; offset?: number; tags: string[] };

describe("tool arguments of a TypeBox schema", () => {
	it("are typed by the schema in execute() and prepareArguments()", () => {
		const tool = defineTool({
			name: "read",
			description: "Reads a file",
			parameters,
			async execute(args) {
				expectTypeOf(args).toEqualTypeOf<Args>();
				return {};
			},
		});
		expectTypeOf<Parameters<typeof tool.execute>[0]>().toEqualTypeOf<Args>();
		expectTypeOf<
			ReturnType<NonNullable<ToolRegistration<typeof parameters>["prepareArguments"]>>
		>().toEqualTypeOf<Args>();
	});
});
