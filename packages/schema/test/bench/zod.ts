// Zod in the comparison. Zod is not a JSON Schema validator: the speed cases are written here as the native Zod
// schemas a developer would write (z.strictObject for closed objects, z.discriminatedUnion for tagged unions, z.lazy
// for recursion), and the corpus schemas are built into the same native calls by `nativeZod`. Only the conformance run
// goes through z.fromJSONSchema, Zod's (semi-experimental) JSON Schema import.

import * as z from "zod";
import type { JsonSchema } from "../../src/index.ts";
import { cases } from "./cases.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const block = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("text"), text: z.string() }),
	z.strictObject({
		kind: z.literal("image"),
		src: z.string(),
		width: z.number().int().min(0),
		height: z.number().int().min(0),
		alt: z.string().optional(),
	}),
	z.strictObject({ kind: z.literal("code"), lang: z.enum(["ts", "js", "py"]), source: z.string() }),
]);

const id = z.number().int().min(0);

const range = z.strictObject({ start: z.number().int().min(1), end: z.number().int().min(1) });
const replace = z.strictObject({ oldText: z.string(), newText: z.string() });
const lineEdit = z.strictObject({ range, text: z.string() });

const richText = z.strictObject({
	type: z.enum(["text", "mention"]),
	content: z.string().max(2000),
	annotations: z.strictObject({ bold: z.boolean(), italic: z.boolean(), color: z.string() }).optional(),
});

type PageBlock = {
	type: "paragraph" | "heading_1" | "heading_2" | "bulleted_list_item" | "to_do";
	rich_text: z.infer<typeof richText>[];
	checked?: boolean;
	children?: PageBlock[];
};

const pageBlock: z.ZodType<PageBlock> = z.lazy(() =>
	z.strictObject({
		type: z.enum(["paragraph", "heading_1", "heading_2", "bulleted_list_item", "to_do"]),
		rich_text: z.array(richText),
		checked: z.boolean().optional(),
		children: z.array(pageBlock).optional(),
	}),
);

/** The speed cases as native Zod schemas, by case name (the JSON Schema cases in cases.ts, one for one). */
const native: Record<string, z.ZodType> = {
	"small closed object": z.strictObject({ text: z.string() }),
	"nested object with tagged unions": z.strictObject({
		id: z.string().regex(uuid),
		title: z.string().min(1).max(200),
		tags: z.array(z.string()).max(16),
		author: z.strictObject({ name: z.string(), email: z.string().optional() }),
		blocks: z.array(block),
		score: z.number().min(0).max(1).optional(),
		draft: z.boolean().optional(),
	}),
	"message union of 5": z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("hello"),
			protocol: z.number().int().min(0),
			incarnation: z.string().regex(uuid),
			calls: z.number().int().min(1),
		}),
		z.strictObject({
			kind: z.literal("hold"),
			hold: id,
			type: z.string(),
			version: z.number().int().min(1),
			fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
			params: z.unknown(),
			address: z.strictObject({ kind: z.string(), params: z.unknown() }),
			chain: z.array(z.string().regex(uuid)).max(64).optional(),
		}),
		z.strictObject({ kind: z.literal("release"), hold: id }),
		z.strictObject({ kind: z.literal("call"), call: id, hold: id, method: id, args: z.unknown().optional() }),
		z.strictObject({ kind: z.literal("abort"), call: id }),
	]),
	"tool: read": z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
	"tool: edit": z.object({ path: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })) }),
	"tool: bash": z.object({ command: z.string(), timeout: z.number().optional() }),
	"MCP create_issue (pattern, anyOf, enum)": z.strictObject({
		owner: z
			.string()
			.min(1)
			.regex(/^[A-Za-z0-9-]+$/),
		repo: z
			.string()
			.min(1)
			.regex(/^[A-Za-z0-9._-]+$/),
		title: z.string().min(1),
		body: z.string().optional(),
		labels: z.array(z.string()).optional(),
		assignees: z.array(z.string()).optional(),
		milestone: z.number().nullable().optional(),
		state: z.enum(["open", "closed"]).optional(),
	}),
	"MCP edit_file ($ref, anyOf)": z.strictObject({
		path: z.string().regex(/^(\/|\.\/|[A-Za-z]:\\)?[^\u0000]+$/),
		edits: z.array(z.union([replace, lineEdit])).min(1),
		dryRun: z.boolean().optional(),
	}),
	"MCP create_page (recursive $ref, oneOf)": z.strictObject({
		parent: z.union([
			z.strictObject({ page_id: z.string().regex(uuid) }),
			z.strictObject({ database_id: z.string().regex(uuid) }),
		]),
		title: z.string().min(1),
		due: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional(),
		children: z.array(pageBlock).max(100).optional(),
	}),
};

/** The native Zod schema of each speed case's JSON Schema. */
export const nativeCases: ReadonlyMap<JsonSchema, z.ZodType> = new Map(
	cases.map((c) => {
		const schema = native[c.name];
		if (schema === undefined) throw new Error(`No native Zod schema for the case ${c.name}`);
		return [c.schema, schema];
	}),
);

type Json = Record<string, unknown>;

/**
 * The native Zod schema a developer would write for a corpus schema (corpus.ts): objects (closed ones strict),
 * strings with bounds, patterns and enums, bounded integers, numbers, booleans, string arrays, descriptions, and
 * $defs reused through their constant. Throws for any other shape.
 */
export function nativeZod(schema: Json, root: Json = schema): z.ZodType {
	if (typeof schema.$ref === "string") {
		const name = schema.$ref.replace("#/$defs/", "");
		return nativeZod((root.$defs as Record<string, Json>)[name], root);
	}
	const built = nativeType(schema, root);
	return typeof schema.description === "string" ? built.describe(schema.description) : built;
}

function nativeType(schema: Json, root: Json): z.ZodType {
	switch (schema.type) {
		case "object": {
			const required = new Set(schema.required as string[]);
			const shape: Record<string, z.ZodType> = {};
			for (const [key, value] of Object.entries(schema.properties as Record<string, Json>)) {
				const property = nativeZod(value, root);
				shape[key] = required.has(key) ? property : property.optional();
			}
			return schema.additionalProperties === false ? z.strictObject(shape) : z.object(shape);
		}
		case "string": {
			if (Array.isArray(schema.enum)) return z.enum(schema.enum as [string, ...string[]]);
			let string = z.string();
			if (typeof schema.minLength === "number") string = string.min(schema.minLength);
			if (typeof schema.maxLength === "number") string = string.max(schema.maxLength);
			if (typeof schema.pattern === "string") string = string.regex(new RegExp(schema.pattern));
			return string;
		}
		case "integer":
			return z
				.number()
				.int()
				.min(schema.minimum as number)
				.max(schema.maximum as number);
		case "number":
			return z.number();
		case "boolean":
			return z.boolean();
		case "array":
			return z.array(z.string()).max(schema.maxItems as number);
		default:
			throw new Error(`No native Zod builder for ${JSON.stringify(schema).slice(0, 80)}`);
	}
}

/** z.fromJSONSchema with the draft given; it accepts only local $refs, so remote documents are not passed. */
export function zodFromJsonSchema(schema: JsonSchema, draft: "2020-12" | "7"): z.ZodType {
	return z.fromJSONSchema(schema as never, { defaultTarget: draft === "7" ? "draft-7" : "draft-2020-12" });
}
