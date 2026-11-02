// Speed cases: realistic schemas with a valid and an invalid value each. Argument checks shaped like Chord's
// contracts (closed objects, tagged unions), pi's built-in tool schemas, and MCP tool schemas with $ref and anyOf.

import type { JsonSchema } from "../../src/index.ts";

/** A schema, the draft it is written in, and one valid and one invalid value. */
export interface Case {
	readonly name: string;
	readonly schema: JsonSchema;
	readonly valid: unknown;
	readonly invalid: unknown;
}

type Props = Record<string, object>;
const closed = (properties: Props, optional: string[] = []) => ({
	type: "object",
	properties,
	required: Object.keys(properties).filter((k) => !optional.includes(k)),
	additionalProperties: false,
});
const str = (o: object = {}) => ({ type: "string", ...o });
const int = (o: object = {}) => ({ type: "integer", ...o });
const num = (o: object = {}) => ({ type: "number", ...o });
const lit = (v: string) => ({ const: v });
const arr = (items: object, o: object = {}) => ({ type: "array", items, ...o });
const uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const block = {
	anyOf: [
		closed({ kind: lit("text"), text: str() }),
		closed({ kind: lit("image"), src: str(), width: int({ minimum: 0 }), height: int({ minimum: 0 }), alt: str() }, [
			"alt",
		]),
		closed({ kind: lit("code"), lang: { anyOf: [lit("ts"), lit("js"), lit("py")] }, source: str() }),
	],
};

const document = closed(
	{
		id: str({ pattern: uuid }),
		title: str({ minLength: 1, maxLength: 200 }),
		tags: arr(str(), { maxItems: 16 }),
		author: closed({ name: str(), email: str() }, ["email"]),
		blocks: arr(block),
		score: num({ minimum: 0, maximum: 1 }),
		draft: { type: "boolean" },
	},
	["score", "draft"],
);

const documentValue = {
	id: "01890a5d-ac96-774b-bcce-b302099a8057",
	title: "Quarterly notes",
	tags: ["a", "b", "c"],
	author: { name: "Mario", email: "m@example.com" },
	blocks: [
		{ kind: "text", text: "Hello" },
		{ kind: "image", src: "a.png", width: 640, height: 480 },
		{ kind: "code", lang: "ts", source: "const x = 1;" },
		{ kind: "text", text: "World" },
		{ kind: "image", src: "b.png", width: 10, height: 20, alt: "b" },
	],
	score: 0.5,
};

const id = int({ minimum: 0 });
const message = {
	anyOf: [
		closed({
			kind: lit("hello"),
			protocol: int({ minimum: 0 }),
			incarnation: str({ pattern: uuid }),
			calls: int({ minimum: 1 }),
		}),
		closed(
			{
				kind: lit("hold"),
				hold: id,
				type: str(),
				version: int({ minimum: 1 }),
				fingerprint: str({ pattern: "^[0-9a-f]{16}$" }),
				params: {},
				address: closed({ kind: str(), params: {} }),
				chain: arr(str({ pattern: uuid }), { maxItems: 64 }),
			},
			["chain"],
		),
		closed({ kind: lit("release"), hold: id }),
		closed({ kind: lit("call"), call: id, hold: id, method: id, args: {} }, ["args"]),
		closed({ kind: lit("abort"), call: id }),
	],
};

const tool = (properties: Props, required: string[]) => ({ type: "object", properties, required });

const mcpIssue = {
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "object",
	properties: {
		owner: str({ minLength: 1, pattern: "^[A-Za-z0-9-]+$" }),
		repo: str({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$" }),
		title: str({ minLength: 1 }),
		body: str(),
		labels: arr(str()),
		assignees: arr(str()),
		milestone: { anyOf: [{ type: "number" }, { type: "null" }] },
		state: { type: "string", enum: ["open", "closed"] },
	},
	required: ["owner", "repo", "title"],
	additionalProperties: false,
};

const mcpEdit = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	$defs: {
		Range: closed({ start: int({ minimum: 1 }), end: int({ minimum: 1 }) }),
		Replace: closed({ oldText: str(), newText: str() }),
		LineEdit: closed({ range: { $ref: "#/$defs/Range" }, text: str() }),
	},
	properties: {
		path: str({ pattern: "^(/|\\./|[A-Za-z]:\\\\)?[^\\u0000]+$" }),
		edits: arr({ anyOf: [{ $ref: "#/$defs/Replace" }, { $ref: "#/$defs/LineEdit" }] }, { minItems: 1 }),
		dryRun: { type: "boolean" },
	},
	required: ["path", "edits"],
	additionalProperties: false,
};

const mcpPage = {
	type: "object",
	$defs: {
		RichText: closed(
			{
				type: { enum: ["text", "mention"] },
				content: str({ maxLength: 2000 }),
				annotations: closed({ bold: { type: "boolean" }, italic: { type: "boolean" }, color: str() }, [
					"bold",
					"italic",
					"color",
				]),
			},
			["annotations"],
		),
		Block: {
			type: "object",
			properties: {
				type: { enum: ["paragraph", "heading_1", "heading_2", "bulleted_list_item", "to_do"] },
				rich_text: arr({ $ref: "#/$defs/RichText" }),
				checked: { type: "boolean" },
				children: arr({ $ref: "#/$defs/Block" }),
			},
			required: ["type", "rich_text"],
			additionalProperties: false,
		},
	},
	properties: {
		parent: { oneOf: [closed({ page_id: str({ pattern: uuid }) }), closed({ database_id: str({ pattern: uuid }) })] },
		title: str({ minLength: 1 }),
		due: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
		children: arr({ $ref: "#/$defs/Block" }, { maxItems: 100 }),
	},
	required: ["parent", "title"],
	additionalProperties: false,
};

const rt = (content: string) => ({
	type: "text",
	content,
	annotations: { bold: false, italic: false, color: "default" },
});
const pageValue = {
	parent: { page_id: "01890a5d-ac96-774b-bcce-b302099a8057" },
	title: "Plan",
	due: "2026-11-01",
	children: [
		{ type: "heading_1", rich_text: [rt("Plan")] },
		{
			type: "bulleted_list_item",
			rich_text: [rt("one")],
			children: [{ type: "to_do", rich_text: [rt("sub")], checked: true }],
		},
		{ type: "paragraph", rich_text: [rt("a"), rt("b"), rt("c")] },
	],
};
const pageInvalid = structuredClone(pageValue);
pageInvalid.children[1].children = [{ type: "to_do", rich_text: [rt("sub")], checked: "yes" as unknown as boolean }];

/** The speed cases. */
export const cases: readonly Case[] = [
	{ name: "small closed object", schema: closed({ text: str() }), valid: { text: "hello" }, invalid: { text: 1 } },
	{
		name: "nested object with tagged unions",
		schema: document,
		valid: documentValue,
		invalid: {
			...documentValue,
			blocks: [...documentValue.blocks.slice(0, 4), { kind: "image", src: "b.png", width: -1, height: 20 }],
		},
	},
	{
		name: "message union of 5",
		schema: message,
		valid: { kind: "call", call: 7, hold: 3, method: 1, args: { a: 1 } },
		invalid: { kind: "call", call: 7, hold: 3, method: 1, extra: true },
	},
	{
		name: "tool: read",
		schema: tool({ path: str({ description: "Path to the file" }), offset: num(), limit: num() }, ["path"]),
		valid: { path: "src/a.ts", offset: 10, limit: 50 },
		invalid: { offset: 1 },
	},
	{
		name: "tool: edit",
		schema: tool({ path: str(), edits: arr(tool({ oldText: str(), newText: str() }, ["oldText", "newText"])) }, [
			"path",
			"edits",
		]),
		valid: {
			path: "a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		},
		invalid: { path: "a.ts", edits: [{ oldText: "a" }] },
	},
	{
		name: "tool: bash",
		schema: tool({ command: str(), timeout: num() }, ["command"]),
		valid: { command: "ls -la", timeout: 30 },
		invalid: { command: 5 },
	},
	{
		name: "MCP create_issue (pattern, anyOf, enum)",
		schema: mcpIssue,
		valid: {
			owner: "earendil-works",
			repo: "pi",
			title: "Bug",
			body: "...",
			labels: ["bug"],
			milestone: null,
			state: "open",
		},
		invalid: { owner: "earendil works", repo: "pi", title: "Bug" },
	},
	{
		name: "MCP edit_file ($ref, anyOf)",
		schema: mcpEdit,
		valid: {
			path: "./src/a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ range: { start: 1, end: 3 }, text: "x" },
			],
		},
		invalid: { path: "./src/a.ts", edits: [{ range: { start: 0, end: 3 }, text: "x" }] },
	},
	{ name: "MCP create_page (recursive $ref, oneOf)", schema: mcpPage, valid: pageValue, invalid: pageInvalid },
];
